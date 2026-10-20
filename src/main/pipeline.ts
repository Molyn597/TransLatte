import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { detect } from 'tinyld';
import { isSupported } from '../shared/languages';
import type { DocumentContext, GlossaryEntry, Job, Progress, Rates, Segment, Settings, Stage } from '../shared/types';
import { selectPages } from '../shared/pages';
import { documentOrder, rewriteDates, type DateOrder } from './dates';
import { buildDocx } from './docx';
import { chat, complete, ensureModel, ensureServer, isVisionModel } from './lmstudio';
import { closePdf, openPdf, pageText, renderPage } from './pdf';
import {
  OCR_PROMPT,
  TABLE_PROMPT,
  contextPrompt,
  fixSystem,
  fixUser,
  isTranslateGemma,
  translateGemmaPrompt,
  translateSystem,
} from './prompts';
import { hasRepetition, relevantGlossary, suspiciousLength, wordOverlap } from './quality';
import {
  acceptFix,
  applyDeterministic,
  findIssues,
  fixCzech,
  parseContext,
  reviewGlossary,
  type Issue,
  type ReviewOptions,
} from './review';
import { ensureDictionary } from './spell';
import { SpellWorker, spellWorkerPath } from './spell-client';
import {
  blocksToSegments,
  dropDuplicateBlocks,
  dropRepeatedBlocks,
  finalText,
  groupSegments,
  layoutToBlocks,
  markdownToBlocks,
  mergeAcrossPages,
  mergeBrokenHeadings,
  normalizeMarkdownTable,
  parseOcr,
  removePageFurniture,
  segmentsToMarkdown,
  sentenceChunks,
  splitBatch,
  stripAddedPeriod,
  type Block,
} from './segments';
import type { Store } from './store';

const BATCH_CHARS = 1500;
// LM Studio zpracuje víc požadavků najednou; na M5 Air to zrychlí překlad zhruba o třetinu.
const PARALLEL = 4;
const SCAN_TEXT_CHARS = 50;
const OCR_MATCH = 0.85;
const ID = { ocr: 'translatte-ocr', translate: 'translatte-translate', polish: 'translatte-polish' };
const CONTEXT_CHARS = 6000;
const CONTEXT_SECONDS = 10;
// Odhad před kontrolou: opravu potřebuje zhruba každý sedmý segment.
const FIX_SHARE = 0.15;
const SPELL_BATCH = 40;

export const outputName = (job: Job) => `${job.name} (${job.targetLang.toUpperCase()}).docx`;

export interface JobContext {
  job: Job;
  settings: Settings;
  glossary: GlossaryEntry[];
  store: Store;
  signal: AbortSignal;
  progress: (p: Progress) => void;
  /** Počet stránek, které prošly OCR (pro zpřesnění odhadu). */
  ocrCount?: number;
}

/** Naměřené časy, ze kterých se zpřesňuje odhad příštích úloh. */
export interface Measured {
  ocrPerPage?: number;
  translatePerKChar?: number;
  fixPerSegment?: number;
}

interface Plan {
  ocrPages: number;
  chars: number;
  context: boolean;
  /** Počet segmentů k opravě (před kontrolou odhad). */
  fixes: number;
}

class Eta {
  private stageStart = Date.now();
  private stage: Stage | undefined;

  constructor(
    private rates: Rates,
    private plan: Plan,
  ) {}

  setPlan(plan: Partial<Plan>) {
    Object.assign(this.plan, plan);
  }

  private estimate(stage: Stage) {
    const k = this.plan.chars / 1000;
    if (stage === 'ocr') return this.plan.ocrPages * this.rates.ocrPerPage;
    if (stage === 'context') return this.plan.context ? CONTEXT_SECONDS : 0;
    if (stage === 'translate') return k * this.rates.translatePerKChar;
    if (stage === 'fix') return this.plan.fixes * this.rates.fixPerSegment;
    return 0;
  }

  /** Zbytek aktuální fáze podle skutečného tempa + odhad fází, které ještě přijdou. */
  remaining(stage: Stage, done: number, total: number) {
    if (stage !== this.stage) {
      this.stage = stage;
      this.stageStart = Date.now();
    }
    const order: Stage[] = ['ocr', 'context', 'translate', 'check', 'fix'];
    const elapsed = (Date.now() - this.stageStart) / 1000;
    const current =
      done > 0 && total > 0 ? (elapsed / done) * (total - done) : this.estimate(stage) * (total ? 1 - done / total : 1);
    const later = order.slice(order.indexOf(stage) + 1).reduce((s, st) => s + this.estimate(st), 0);
    return Math.round(current + (order.includes(stage) ? later : 0));
  }
}

function check(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError');
}

/** Zpracuje položky nejvýš po `limit` souběžně (pořadí výsledků se nemění). */
async function eachParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- Načtení dokumentu ----------

function htmlToBlocks(html: string): Block[] {
  const text = (s: string) =>
    s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  const blocks: Block[] = [];
  for (const m of html.matchAll(/<(h[1-6]|p|ul|ol|table)[^>]*>(.*?)<\/\1>/gis)) {
    const [, tag, inner] = m;
    if (/^h/i.test(tag)) blocks.push({ kind: 'heading', text: text(inner) });
    else if (/^[uo]l$/i.test(tag)) {
      const items = [...inner.matchAll(/<li[^>]*>(.*?)<\/li>/gis)].map((li, i) =>
        `${tag.toLowerCase() === 'ol' ? `${i + 1}.` : '-'} ${text(li[1])}`,
      );
      if (items.length) blocks.push({ kind: 'list', text: items.join('\n') });
    } else if (/^table$/i.test(tag)) {
      const rows = [...inner.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)].map((r) =>
        [...r[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)].map((c) => text(c[1]).replace(/\|/g, '/')),
      );
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const line = (c: string[]) => `| ${[...c, ...Array(width - c.length).fill('')].join(' | ')} |`;
        blocks.push({ kind: 'table', text: [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') });
      }
    } else if (text(inner)) blocks.push({ kind: 'paragraph', text: text(inner) });
  }
  return blocks.filter((b) => b.text);
}

async function ocrPage(ctx: JobContext, docId: string, page: number, scale: number) {
  const image = await renderPage(docId, page, scale);
  return chat(
    ctx.settings.apiUrl,
    ID.ocr,
    [{ role: 'user', content: [{ type: 'text', text: OCR_PROMPT }, { type: 'image_url', image_url: { url: image } }] }],
    { maxTokens: 6000, signal: ctx.signal },
  );
}

const blocksText = (blocks: Block[]) => blocks.map((b) => b.text).join('\n');

const TABLE_FALLBACK = 'Tabulku se nepodařilo přečíst po buňkách, je převedená na text. Zkontroluj ji proti originálu.';

/** Tabulky bez buněk přečte znovu vision model pro opravy z výřezu stránky. */
async function repairTables(ctx: JobContext, docId: string, blocks: Block[]) {
  const broken = blocks.filter((b) => b.needsRepair);
  if (!broken.length) return;
  const vision = await isVisionModel(ctx.settings.models.polish);
  if (vision) await ensureModel(ctx.settings.models.polish, ID.polish);
  for (const [i, block] of broken.entries()) {
    check(ctx.signal);
    ctx.progress({ stage: 'tables', done: i, total: broken.length });
    let table: string | null = null;
    if (vision && block.box && block.page) {
      const pad = 0.012;
      const [x0, y0, x1, y1] = block.box.map((v) => v / 999);
      const image = await renderPage(docId, block.page, 3, [x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
      const out = await chat(
        ctx.settings.apiUrl,
        ID.polish,
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: TABLE_PROMPT }] }],
        { maxTokens: 3000, signal: ctx.signal },
      );
      table = normalizeMarkdownTable(out);
    }
    if (table) block.text = table;
    else {
      block.kind = 'paragraph';
      block.warning = TABLE_FALLBACK;
    }
    block.needsRepair = false;
  }
}

async function extractPdf(ctx: JobContext, file: string, eta: Eta): Promise<Segment[]> {
  const { job, settings } = ctx;
  const docId = job.id;
  const { pages: total } = await openPdf(docId, new Uint8Array(await readFile(file)));
  try {
    const selected = selectPages(job.pageRange, total);
    job.pages = selected.length;
    const texts = [];
    for (const p of selected) texts.push(await pageText(docId, p));
    const content = removePageFurniture(texts);
    const layouts = texts.map(({ items, width }, i) => ({
      page: selected[i],
      blocks: layoutToBlocks(content[i], width, selected[i]),
      scanned: items.reduce((n, it) => n + it.str.trim().length, 0) < SCAN_TEXT_CHARS,
    }));
    // Rychlý režim čte digitální stránky z textové vrstvy, OCR jen u skenů.
    const ocrPages = layouts.filter((l) => job.mode !== 'fast' || l.scanned).map((l) => l.page);
    eta.setPlan({ ocrPages: ocrPages.length, chars: layouts.reduce((n, l) => n + blocksText(l.blocks).length, 0) });
    ctx.ocrCount = ocrPages.length;
    if (ocrPages.length) await ensureModel(settings.models.ocr, ID.ocr);

    const blocks: Block[] = [];
    const warnings = new Map<number, string>();
    let done = 0;
    for (const layout of layouts) {
      check(ctx.signal);
      const p = layout.page;
      if (!ocrPages.includes(p)) {
        blocks.push(...layout.blocks);
        continue;
      }
      ctx.progress({ stage: 'ocr', done, total: ocrPages.length, eta: eta.remaining('ocr', done, ocrPages.length) });
      let result = parseOcr(await ocrPage(ctx, docId, p, 2), p);
      const reference = blocksText(layout.blocks);
      const bad = (b: Block[]) => {
        const text = blocksText(b);
        if (!text.trim() || hasRepetition(text)) return true;
        if (layout.scanned) return false;
        const { recall, precision } = wordOverlap(reference, text);
        return recall < OCR_MATCH || precision < OCR_MATCH;
      };
      if (bad(result)) result = parseOcr(await ocrPage(ctx, docId, p, 3), p); // druhý pokus ve vyšším rozlišení
      if (bad(result)) {
        if (layout.scanned) warnings.set(p, 'OCR této stránky může obsahovat chyby. Zkontroluj ji proti originálu.');
        else {
          result = layout.blocks;
          // U krátké stránky (zápatí webu, titulní list) na pořadí odstavců nezáleží.
          if (reference.length > 400) {
            warnings.set(p, 'OCR se neshodovalo s textem v PDF, proto je použit text přímo z PDF (může mít horší pořadí odstavců).');
          }
        }
      } else if (!layout.scanned) {
        // Text z obrázků a ikon (sdílení, loga), který v PDF není, se nepřekládá.
        result = result.filter((b) => b.kind === 'table' || wordOverlap(reference, b.text).precision >= 0.5);
      }
      blocks.push(...result);
      done++;
    }
    await repairTables(ctx, docId, blocks);
    const segments = blocksToSegments(dropDuplicateBlocks(mergeBrokenHeadings(mergeAcrossPages(dropRepeatedBlocks(blocks)))));
    for (const s of segments) if (s.page && warnings.has(s.page)) s.warning ??= warnings.get(s.page);
    return segments;
  } finally {
    await closePdf(docId);
  }
}

async function extract(ctx: JobContext, file: string, eta: Eta): Promise<Segment[]> {
  const ext = ctx.job.ext.toLowerCase();
  if (ext === '.pdf') return extractPdf(ctx, file, eta);
  if (ext === '.docx') {
    const { value } = await mammoth.convertToHtml({ path: file });
    return blocksToSegments(htmlToBlocks(value));
  }
  return blocksToSegments(markdownToBlocks((await readFile(file, 'utf8')).replace(/\r\n/g, '\n')));
}

// ---------- Překlad ----------

async function translateText(ctx: JobContext, text: string) {
  const { settings, job } = ctx;
  const model = settings.models.translate;
  const maxTokens = Math.min(4000, Math.ceil(text.length / 1.5) + 200);
  if (isTranslateGemma(model)) {
    return complete(settings.apiUrl, ID.translate, translateGemmaPrompt(text, job.sourceLang, job.targetLang), {
      stop: ['<end_of_turn>'],
      maxTokens,
      signal: ctx.signal,
    });
  }
  return chat(
    settings.apiUrl,
    ID.translate,
    [
      { role: 'system', content: translateSystem(job.sourceLang, job.targetLang) },
      { role: 'user', content: text },
    ],
    { maxTokens, signal: ctx.signal },
  );
}

async function translateTable(ctx: JobContext, table: string) {
  const rows = table.split('\n');
  const cells: string[] = [];
  for (const row of rows) {
    if (/^\|[\s|:-]+\|$/.test(row.trim())) continue;
    for (const c of row.replace(/^\s*\||\|\s*$/g, '').split('|')) {
      if (/\p{L}{2}/u.test(c)) cells.push(c.trim());
    }
  }
  const unique = [...new Set(cells)];
  const translated = new Map<string, string>();
  const batch = splitBatch(await translateText(ctx, unique.join('\n\n')), unique.length);
  for (const [i, c] of unique.entries()) translated.set(c, batch ? batch[i] : await translateText(ctx, c));
  return rows
    .map((row) =>
      /^\|[\s|:-]+\|$/.test(row.trim())
        ? row
        : row.replace(/(?<=\|)([^|]+)(?=\|)/g, (cell) => {
            const t = translated.get(cell.trim());
            return t ? ` ${t.replace(/\|/g, '/')} ` : cell;
          }),
    )
    .join('\n');
}

const looksWrong = (source: string, out: string) => !out || suspiciousLength(source, out) || hasRepetition(out);

/** Část odstavce k překladu; dlouhé odstavce se dělí po větách, aby šly zpracovat souběžně. */
interface Unit {
  seg: Segment;
  source: string;
  /** Zdroj s daty přepsanými na jednoznačný tvar; tohle dostane překladač. */
  prepared: string;
  translation?: string;
}

const LONG_PARAGRAPH = 900;

function addNotes(seg: Segment, notes: string[]) {
  if (notes.length) seg.warning = [seg.warning, ...notes].filter(Boolean).join(' ');
}

function toUnits(ctx: JobContext, segments: Segment[], order: DateOrder | undefined): Unit[] {
  const { sourceLang, targetLang } = ctx.job;
  return segments
    .filter((s) => s.kind !== 'table')
    .flatMap((seg) => {
      const parts = seg.kind === 'paragraph' && seg.source.length > LONG_PARAGRAPH ? sentenceChunks(seg.source, LONG_PARAGRAPH) : [seg.source];
      return parts.map((source) => {
        const { text, notes } = rewriteDates(source, sourceLang, targetLang, order);
        addNotes(seg, notes);
        return { seg, source, prepared: text };
      });
    });
}

const unitGroups = (units: Unit[]) =>
  groupSegments(
    units.map((u, id) => ({ id, kind: u.seg.kind, source: u.prepared })),
    BATCH_CHARS,
  ).map((g) => g.map((i) => units[i]));

const joinUnits = (units: Unit[], seg: Segment, pick: (u: Unit) => string) =>
  units
    .filter((u) => u.seg === seg)
    .map(pick)
    .join(' ');

async function translateAll(ctx: JobContext, segments: Segment[], eta: Eta) {
  // Pořadí den/měsíc platí pro celý dokument („25/12/2014“ jinde rozhodne i „03/10/2014“).
  const order = documentOrder(segments.map((s) => s.source));
  const units = toUnits(ctx, segments, order);
  const total = segments.reduce((n, s) => n + s.source.length, 0);
  let done = 0;
  const report = (chars: number) => {
    done += chars;
    ctx.progress({ stage: 'translate', done, total, eta: eta.remaining('translate', done, total) });
  };
  await ensureModel(ctx.settings.models.translate, ID.translate);
  report(0);
  const tasks: (() => Promise<void>)[] = [
    ...segments
      .filter((s) => s.kind === 'table')
      .map((table) => async () => {
        const { text, notes } = rewriteDates(table.source, ctx.job.sourceLang, ctx.job.targetLang, order);
        addNotes(table, notes);
        table.translation = await translateTable(ctx, text);
        report(table.source.length);
      }),
    ...unitGroups(units).map((items) => async () => {
      check(ctx.signal);
      const parts = splitBatch(await translateText(ctx, items.map((u) => u.prepared).join('\n\n')), items.length);
      for (const [i, u] of items.entries()) {
        // Dávka se nerozdělila na stejný počet odstavců nebo část vypadá useknutě: přeložit zvlášť.
        if (parts && !looksWrong(u.prepared, parts[i])) u.translation = parts[i];
        else {
          u.translation = await translateText(ctx, u.prepared);
          if (looksWrong(u.prepared, u.translation)) addNotes(u.seg, ['Překlad tohoto odstavce může být neúplný.']);
        }
      }
      report(items.reduce((n, u) => n + u.source.length, 0));
    }),
  ];
  await eachParallel(tasks, PARALLEL, (task) => task());
  for (const seg of segments) {
    if (seg.kind !== 'table') seg.translation = stripAddedPeriod(seg.source, joinUnits(units, seg, (u) => u.translation ?? ''));
  }
}

// ---------- Kontext, kontrola a oprava ----------

const addJobNote = (job: Job, note: string) => (job.notes ??= []).push(note);

/** Téma, autor a termíny z úvodu dokumentu (Gemma); při chybě se pokračuje bez kontextu. */
async function readContext(ctx: JobContext, segments: Segment[], eta: Eta): Promise<DocumentContext | undefined> {
  const { settings, job } = ctx;
  ctx.progress({ stage: 'context', done: 0, total: 0, eta: eta.remaining('context', 0, 0) });
  const sample = segments
    .filter((s) => s.kind !== 'table')
    .map((s) => s.source)
    .join('\n\n')
    .slice(0, CONTEXT_CHARS);
  await ensureModel(settings.models.polish, ID.polish);
  let context: DocumentContext | undefined;
  try {
    const out = await chat(settings.apiUrl, ID.polish, [{ role: 'user', content: contextPrompt(sample, job.targetLang) }], {
      maxTokens: 1200,
      signal: ctx.signal,
    });
    context = parseContext(out);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
  }
  if (!context) addJobNote(job, 'Kontext dokumentu se nepodařilo zjistit, opravy proběhly bez něj.');
  return context;
}

/** Kontrola pravopisu ve workeru; bez slovníku (offline) se přeskočí s poznámkou u úlohy. */
async function startSpeller(ctx: JobContext): Promise<SpellWorker | undefined> {
  try {
    const dictionary = await ensureDictionary(path.join(ctx.store.root, 'dictionaries'), ctx.signal);
    check(ctx.signal);
    return new SpellWorker(spellWorkerPath(__dirname), dictionary);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    addJobNote(ctx.job, `Kontrola pravopisu se přeskočila: ${(err as Error).message}`);
    return undefined;
  }
}

interface Reviewer {
  options: ReviewOptions;
  spell(items: { translation: string; source: string }[]): Promise<string[][]>;
}

function reviewer(ctx: JobContext, speller: SpellWorker | undefined): Reviewer {
  const { job } = ctx;
  let working = speller;
  return {
    options: { sourceLang: job.sourceLang, targetLang: job.targetLang, mode: job.mode, glossary: ctx.glossary, context: job.context },
    async spell(items) {
      if (!working) return items.map(() => []);
      try {
        return await working.check(items);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        // Spadlý worker (např. nedostatek paměti) úlohu nezastaví, jen se dál nekontroluje pravopis.
        working = undefined;
        addJobNote(job, `Kontrola pravopisu se přerušila: ${(err as Error).message}`);
        return items.map(() => []);
      }
    },
  };
}

async function checkAll(ctx: JobContext, segments: Segment[], r: Reviewer, eta: Eta) {
  const todo = segments.filter((s) => s.kind !== 'table');
  const issues = new Map<Segment, Issue[]>();
  const report = (done: number) => ctx.progress({ stage: 'check', done, total: todo.length, eta: eta.remaining('check', done, todo.length) });
  report(0);
  for (let i = 0; i < todo.length; i += SPELL_BATCH) {
    check(ctx.signal);
    const batch = todo.slice(i, i + SPELL_BATCH);
    const misspelled = await r.spell(batch.map((s) => ({ translation: finalText(s), source: s.source })));
    batch.forEach((s, j) => {
      const found = findIssues(s, finalText(s), misspelled[j], r.options);
      if (found.length) issues.set(s, found);
    });
    report(Math.min(i + SPELL_BATCH, todo.length));
  }
  return issues;
}

async function fixSegment(ctx: JobContext, seg: Segment, issues: Issue[], r: Reviewer): Promise<Issue[]> {
  const { settings, job } = ctx;
  const before = finalText(seg);
  const cs = job.targetLang === 'cs';
  const out = await chat(
    settings.apiUrl,
    ID.polish,
    [
      { role: 'system', content: fixSystem(job.targetLang, relevantGlossary(seg.source, reviewGlossary(r.options)), job.context) },
      { role: 'user', content: fixUser(seg.source, before, issues.map((i) => (cs ? i.text : i.en)), job.targetLang) },
    ],
    { maxTokens: Math.min(4000, Math.ceil(before.length / 1.5) + 200), signal: ctx.signal },
  );
  let after = stripAddedPeriod(seg.source, out);
  if (cs) after = fixCzech(after);
  const [misspelled] = await r.spell([{ translation: after, source: seg.source }]);
  const remaining = findIssues(seg, after, misspelled, r.options);
  if (!acceptFix(seg.source, before, after, issues, remaining)) return issues;
  seg.polished = after;
  return remaining;
}

async function fixAll(ctx: JobContext, found: Map<Segment, Issue[]>, r: Reviewer, eta: Eta) {
  const todo = [...found.keys()];
  let done = 0;
  const report = () => ctx.progress({ stage: 'fix', done, total: todo.length, eta: eta.remaining('fix', done, todo.length) });
  await ensureModel(ctx.settings.models.polish, ID.polish);
  report();
  await eachParallel(todo, PARALLEL, async (seg) => {
    check(ctx.signal);
    try {
      found.set(seg, await fixSegment(ctx, seg, found.get(seg)!, r));
    } catch (err) {
      // Neúspěšná oprava jednoho odstavce nezastaví úlohu; zůstane překlad a upozornění.
      if (ctx.signal.aborted) throw err;
    }
    done++;
    report();
  });
}

function detectLanguage(segments: Segment[]) {
  const sample = segments
    .map((s) => s.source)
    .join('\n')
    .slice(0, 6000);
  const code = detect(sample);
  return isSupported(code) ? code : 'en';
}

export async function runJob(ctx: JobContext): Promise<Measured> {
  const { job, settings, store } = ctx;
  const measured: Measured = {};
  const translating = () => job.sourceLang !== job.targetLang;
  const eta = new Eta(settings.rates, { ocrPages: 0, chars: 0, context: job.mode === 'quality', fixes: 0 });

  ctx.progress({ stage: 'prepare', done: 0, total: 0 });
  await ensureServer(settings.apiUrl);

  ctx.progress({ stage: 'extract', done: 0, total: 0 });
  let t = Date.now();
  const segments = await extract(ctx, store.inputPath(job), eta);
  if (!segments.length) throw new Error('V dokumentu se nenašel žádný text.');
  if (ctx.ocrCount) measured.ocrPerPage = (Date.now() - t) / 1000 / ctx.ocrCount;
  job.chars = segments.reduce((n, s) => n + s.source.length, 0);
  const reviewable = segments.filter((s) => s.kind !== 'table').length;
  eta.setPlan({ chars: job.chars, fixes: job.mode === 'fast' ? 0 : Math.round(reviewable * FIX_SHARE) });
  if (job.sourceLang === 'auto') job.sourceLang = detectLanguage(segments);

  if (!translating()) {
    for (const s of segments) s.translation = s.source;
  } else {
    // Kvalitní: Gemma (kontext) → TranslateGemma (překlad) → kontrola bez modelu → Gemma (opravy).
    if (job.mode === 'quality') job.context = await readContext(ctx, segments, eta);
    t = Date.now();
    await translateAll(ctx, segments, eta);
    measured.translatePerKChar = (Date.now() - t) / job.chars;
  }
  applyDeterministic(segments, job.targetLang);

  if (translating()) {
    const speller = job.targetLang === 'cs' ? await startSpeller(ctx) : undefined;
    try {
      const r = reviewer(ctx, speller);
      const found = await checkAll(ctx, segments, r, eta);
      if (job.mode !== 'fast' && found.size) {
        eta.setPlan({ fixes: found.size });
        t = Date.now();
        await fixAll(ctx, found, r, eta);
        measured.fixPerSegment = (Date.now() - t) / 1000 / found.size;
      }
      for (const [seg, issues] of found) addNotes(seg, issues.map((i) => i.text));
    } finally {
      // Ukončení workeru uvolní ~380 MB slovníku.
      await speller?.terminate();
    }
  }

  ctx.progress({ stage: 'write', done: 0, total: 0 });
  const dir = store.jobDir(job.id);
  job.output = outputName(job);
  job.warnings = segments.filter((s) => s.warning).length;
  await store.saveSegments(job.id, segments);
  await writeFile(path.join(dir, job.output), await buildDocx(job.name, segments));
  await writeFile(path.join(dir, job.output.replace(/\.docx$/, '.md')), segmentsToMarkdown(segments));
  return measured;
}
