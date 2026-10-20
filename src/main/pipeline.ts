import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { detect } from 'tinyld';
import { isSupported } from '../shared/languages';
import type { GlossaryEntry, Job, Progress, Rates, Segment, Settings, Stage } from '../shared/types';
import { documentOrder, rewriteDates, type DateOrder } from './dates';
import { buildDocx } from './docx';
import { chat, complete, ensureModel, ensureServer, isVisionModel } from './lmstudio';
import { closePdf, openPdf, pageText, renderPage } from './pdf';
import {
  OCR_PROMPT,
  TABLE_PROMPT,
  isTranslateGemma,
  polishSystem,
  polishUser,
  translateGemmaPrompt,
  translateSystem,
} from './prompts';
import { glossaryMisses, hasRepetition, relevantGlossary, suspiciousLength, wordOverlap } from './quality';
import {
  blocksToSegments,
  dropRepeatedBlocks,
  finalText,
  groupSegments,
  layoutToBlocks,
  markdownToBlocks,
  mergeAcrossPages,
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
  polishPerKChar?: number;
}

class Eta {
  private stageStart = Date.now();
  private stage: Stage | undefined;

  constructor(
    private rates: Rates,
    private plan: { ocrPages: number; chars: number; polish: boolean },
  ) {}

  setPlan(plan: Partial<{ ocrPages: number; chars: number; polish: boolean }>) {
    Object.assign(this.plan, plan);
  }

  private estimate(stage: Stage) {
    const k = this.plan.chars / 1000;
    if (stage === 'ocr') return this.plan.ocrPages * this.rates.ocrPerPage;
    if (stage === 'translate') return k * this.rates.translatePerKChar;
    if (stage === 'polish') return this.plan.polish ? k * this.rates.polishPerKChar : 0;
    return 0;
  }

  /** Zbytek aktuální fáze podle skutečného tempa + odhad fází, které ještě přijdou. */
  remaining(stage: Stage, done: number, total: number) {
    if (stage !== this.stage) {
      this.stage = stage;
      this.stageStart = Date.now();
    }
    const order: Stage[] = ['ocr', 'translate', 'polish'];
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

/** Tabulky bez buněk přečte znovu vision model pro uhlazení z výřezu stránky. */
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
  const { pages } = await openPdf(docId, new Uint8Array(await readFile(file)));
  job.pages = pages;
  try {
    const texts = [];
    for (let p = 1; p <= pages; p++) texts.push(await pageText(docId, p));
    const content = removePageFurniture(texts);
    const layouts = texts.map(({ items, width }, i) => ({
      blocks: layoutToBlocks(content[i], width, i + 1),
      scanned: items.reduce((n, it) => n + it.str.trim().length, 0) < SCAN_TEXT_CHARS,
    }));
    // Rychlý režim čte digitální stránky z textové vrstvy, OCR jen u skenů.
    const ocrPages = layouts
      .map((l, i) => i + 1)
      .filter((p) => job.mode !== 'fast' || layouts[p - 1].scanned);
    eta.setPlan({ ocrPages: ocrPages.length, chars: layouts.reduce((n, l) => n + blocksText(l.blocks).length, 0) });
    ctx.ocrCount = ocrPages.length;
    if (ocrPages.length) await ensureModel(settings.models.ocr, ID.ocr);

    const blocks: Block[] = [];
    const warnings = new Map<number, string>();
    let done = 0;
    for (let p = 1; p <= pages; p++) {
      check(ctx.signal);
      const layout = layouts[p - 1];
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
    const segments = blocksToSegments(mergeAcrossPages(dropRepeatedBlocks(blocks)));
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
  /** Zdroj s daty přepsanými na jednoznačný tvar; tohle dostane překladač i redaktor. */
  prepared: string;
  translation?: string;
  polished?: string;
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

async function translateAll(ctx: JobContext, segments: Segment[], eta: Eta): Promise<Unit[]> {
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
  return units;
}

async function polishText(ctx: JobContext, source: string, translation: string, glossary: GlossaryEntry[]) {
  const { settings, job } = ctx;
  return chat(
    settings.apiUrl,
    ID.polish,
    [
      { role: 'system', content: polishSystem(job.targetLang, glossary) },
      { role: 'user', content: polishUser(source, translation, job.targetLang) },
    ],
    { maxTokens: Math.min(4000, Math.ceil(translation.length / 1.5) + 200), signal: ctx.signal },
  );
}

// Redaktor nesmí odstavec zkrátit ani rozepsat; jinak zůstane původní překlad.
const polishOk = (translation: string, polished: string) =>
  Boolean(polished) && polished.length / Math.max(translation.length, 1) > 0.6 && polished.length / Math.max(translation.length, 1) < 1.6;

async function polishAll(ctx: JobContext, segments: Segment[], units: Unit[], eta: Eta) {
  const groups = unitGroups(units);
  const total = units.reduce((n, u) => n + u.source.length, 0);
  let done = 0;
  await ensureModel(ctx.settings.models.polish, ID.polish);
  ctx.progress({ stage: 'polish', done, total, eta: eta.remaining('polish', done, total) });
  await eachParallel(groups, PARALLEL, async (items) => {
    check(ctx.signal);
    const source = items.map((u) => u.prepared).join('\n\n');
    const translation = items.map((u) => u.translation ?? '').join('\n\n');
    const parts = splitBatch(await polishText(ctx, source, translation, relevantGlossary(source, ctx.glossary)), items.length);
    for (const [i, u] of items.entries()) {
      let polished = parts?.[i];
      if (!polished) polished = await polishText(ctx, u.prepared, u.translation ?? '', relevantGlossary(u.prepared, ctx.glossary));
      u.polished = polishOk(u.translation ?? '', polished) ? polished : u.translation;
    }
    done += items.reduce((n, u) => n + u.source.length, 0);
    ctx.progress({ stage: 'polish', done, total, eta: eta.remaining('polish', done, total) });
  });
  for (const seg of segments) {
    if (seg.kind !== 'table') seg.polished = stripAddedPeriod(seg.source, joinUnits(units, seg, (u) => u.polished ?? u.translation ?? ''));
  }
}

/** Opraví jen odstavce, kde chybí termín z glosáře (TranslateGemma glosář přijmout neumí). */
async function enforceGlossary(ctx: JobContext, segments: Segment[]) {
  const todo = segments.filter((s) => s.kind !== 'table' && glossaryMisses(s.source, finalText(s), ctx.glossary).length);
  if (!todo.length) return;
  await ensureModel(ctx.settings.models.polish, ID.polish);
  let done = 0;
  ctx.progress({ stage: 'glossary', done, total: todo.length });
  await eachParallel(todo, PARALLEL, async (s) => {
    check(ctx.signal);
    const fixed = await polishText(ctx, s.source, finalText(s), relevantGlossary(s.source, ctx.glossary));
    if (polishOk(finalText(s), fixed)) s.polished = stripAddedPeriod(s.source, fixed);
    const still = glossaryMisses(s.source, finalText(s), ctx.glossary);
    if (still.length) s.warning ??= `Chybí termín z glosáře: ${still.map((g) => `${g.source} → ${g.target}`).join(', ')}`;
    ctx.progress({ stage: 'glossary', done: ++done, total: todo.length });
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
  const usePolish = job.mode === 'quality';
  const eta = new Eta(settings.rates, { ocrPages: 0, chars: 0, polish: usePolish });

  ctx.progress({ stage: 'prepare', done: 0, total: 0 });
  await ensureServer(settings.apiUrl);

  ctx.progress({ stage: 'extract', done: 0, total: 0 });
  let t = Date.now();
  const segments = await extract(ctx, store.inputPath(job), eta);
  if (!segments.length) throw new Error('V dokumentu se nenašel žádný text.');
  if (ctx.ocrCount) measured.ocrPerPage = (Date.now() - t) / 1000 / ctx.ocrCount;
  job.chars = segments.reduce((n, s) => n + s.source.length, 0);
  eta.setPlan({ chars: job.chars });
  if (job.sourceLang === 'auto') job.sourceLang = detectLanguage(segments);

  if (job.sourceLang === job.targetLang) {
    for (const s of segments) s.translation = s.source;
  } else {
    t = Date.now();
    const units = await translateAll(ctx, segments, eta);
    measured.translatePerKChar = (Date.now() - t) / job.chars;
    if (usePolish) {
      t = Date.now();
      await polishAll(ctx, segments, units, eta);
      measured.polishPerKChar = (Date.now() - t) / job.chars;
    }
    await enforceGlossary(ctx, segments);
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

