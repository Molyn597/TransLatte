import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeImage } from 'electron';
import mammoth from 'mammoth';
import { detect } from 'tinyld';
import { messagePattern, t } from '../shared/i18n';
import { isSupported, languageName } from '../shared/languages';
import type { DocumentContext, GlossaryEntry, Job, Progress, Rates, RegionTranslation, Segment, Settings, Stage } from '../shared/types';
import { selectPages } from '../shared/pages';
import { findRegion, normalizeCrop, pendingSegments } from '../shared/regions';
import { documentOrder, rewriteDates, type DateOrder } from './dates';
import { buildDocx } from './docx';
import { buildLayoutPdf, type PageGeometry, type PageImage } from './layout-pdf';
import { chat, complete, ensureModel, ensureServer, isVisionModel } from './lmstudio';
import { closePdf, openPdf, pageText, renderPage } from './pdf';
import {
  OCR_PROMPT,
  TABLE_PROMPT,
  contextPrompt,
  regionPrompt,
  fixSystem,
  fixUser,
  isTranslateGemma,
  translateGemmaPrompt,
  translateSystem,
} from './prompts';
import { findAnchors, hasRepetition, isRefusal, relevantGlossary, suspiciousLength, wordOverlap } from './quality';
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
  addUnreadableTables,
  attachLinks,
  blocksToSegments,
  dropRepeatedBlocks,
  finalText,
  groupSegments,
  layoutToBlocks,
  linkAnchors,
  markDuplicateBlocks,
  markdownToBlocks,
  mergeAcrossPages,
  mergeBrokenHeadings,
  normalizeMarkdownTable,
  ocrGeometry,
  parseOcr,
  removePageFurniture,
  segmentsToMarkdown,
  sentenceChunks,
  splitBatch,
  stripAddedPeriod,
  textLayerGeometry,
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
export const outputPdfName = (job: Job) => `${job.name} (${job.targetLang.toUpperCase()}).pdf`;
// Pro barvu pozadí a viditelnost textu stačí bod na pixel.
const BACKGROUND_SCALE = 1;

export interface JobContext {
  job: Job;
  settings: Settings;
  glossary: GlossaryEntry[];
  store: Store;
  signal: AbortSignal;
  progress: (p: Progress) => void;
  /** Počet stránek, které prošly OCR (pro zpřesnění odhadu). */
  ocrCount?: number;
  /** Výřez a otočení stránek PDF pro přeložené PDF. */
  pages?: Map<number, PageGeometry>;
}

/** Naměřené časy, ze kterých se zpřesňuje odhad příštích úloh. */
export interface Measured {
  ocrPerPage?: number;
  translatePerKChar?: number;
  fixPerSegment?: number;
  /** Úloha se po přečtení zastavila a čeká na výběr odstavců. */
  paused?: boolean;
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
    if (table) {
      block.text = table;
      // Tabulka bez textové vrstvy dostane plochu až s textem, podle něj se odhaduje písmo.
      const size = block.page ? ctx.pages?.get(block.page) : undefined;
      if (!block.rects && size) Object.assign(block, ocrGeometry(block, size));
    } else if (!block.text) {
      const caption = blocks[blocks.indexOf(block) - 1];
      if (caption) caption.warning ??= t('pipeline.tableUnread');
    } else {
      block.kind = 'paragraph';
      block.warning = t('pipeline.tableFallback');
    }
    block.needsRepair = false;
  }
}

const geometry = ({ view, rotate, width, height, invisible }: PageGeometry): PageGeometry => ({ view, rotate, width, height, invisible });

async function extractPdf(ctx: JobContext, file: string, eta: Eta): Promise<Segment[]> {
  const { job, settings } = ctx;
  const docId = job.id;
  const { pages: total } = await openPdf(docId, new Uint8Array(await readFile(file)));
  try {
    const selected = selectPages(job.pageRange, total);
    job.pages = selected.length;
    const texts = [];
    for (const p of selected) texts.push(await pageText(docId, p));
    ctx.pages = new Map(texts.map((text, i) => [selected[i], geometry(text)]));
    const content = removePageFurniture(texts);
    const layouts = texts.map(({ items, turned, width, links }, i) => ({
      page: selected[i],
      items: content[i],
      width,
      links: linkAnchors(content[i], links, selected[i]),
      blocks: layoutToBlocks(content[i], width, selected[i]),
      scanned: items.reduce((n, it) => n + it.str.trim().length, turned ?? 0) < SCAN_TEXT_CHARS,
    }));
    // Rychlý režim čte digitální stránky z textové vrstvy, OCR jen u skenů.
    const ocrPages = layouts.filter((l) => job.mode !== 'fast' || l.scanned).map((l) => l.page);
    // Digitální PDF se pozná už z textové vrstvy, dřív než se spustí OCR.
    const layerText = layouts.map((l) => blocksText(l.blocks)).join('\n');
    if (job.sourceLang === 'auto' && layerText.length > 500) rejectSameLanguage(job, detectLanguage(layerText));
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
        attachLinks(layout.blocks, layout.links);
        blocks.push(...addUnreadableTables(layout.blocks, layout.items, ctx.pages.get(p)!));
        continue;
      }
      ctx.progress({ stage: 'ocr', done, total: ocrPages.length, eta: eta.remaining('ocr', done, ocrPages.length) });
      const size = ctx.pages.get(p)!;
      let result = parseOcr(await ocrPage(ctx, docId, p, 2), p, size);
      const reference = blocksText(layout.blocks);
      const bad = (b: Block[]) => {
        const text = blocksText(b);
        if (!text.trim() || hasRepetition(text)) return true;
        if (layout.scanned) return false;
        const { recall, precision } = wordOverlap(reference, text);
        return recall < OCR_MATCH || precision < OCR_MATCH;
      };
      if (bad(result)) result = parseOcr(await ocrPage(ctx, docId, p, 3), p, size); // druhý pokus ve vyšším rozlišení
      if (bad(result)) {
        if (layout.scanned) warnings.set(p, t('pipeline.ocrErrors'));
        else {
          result = layout.blocks;
          // U krátké stránky (zápatí webu, titulní list) na pořadí odstavců nezáleží.
          if (reference.length > 400) {
            warnings.set(p, t('pipeline.ocrMismatch'));
          }
        }
      } else if (!layout.scanned) {
        // Text z obrázků a ikon (sdílení, loga), který v PDF není, se nepřekládá.
        result = result.filter((b) => b.kind === 'table' || wordOverlap(reference, b.text).precision >= 0.5);
        textLayerGeometry(result, layout.items, layout.width);
      }
      attachLinks(result, layout.links);
      blocks.push(...result);
      done++;
    }
    await repairTables(ctx, docId, blocks);
    const segments = blocksToSegments(markDuplicateBlocks(mergeBrokenHeadings(mergeAcrossPages(dropRepeatedBlocks(blocks)))));
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
  for (const [i, c] of unique.entries()) {
    const out = batch ? batch[i] : await translateText(ctx, c);
    if (!isRefusal(c, out)) translated.set(c, out);
  }
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

/** Texty odkazů se překládají zvlášť, aby šly v překladu odstavce najít. Odkaz přes celý odstavec nebo bez písmen (adresa) ne. */
async function translateLinks(ctx: JobContext, segments: Segment[]) {
  const links = segments.flatMap((s) => (s.links ?? []).filter((l) => /\p{L}{2}/u.test(l.source) && !/^(https?:|www\.)/i.test(l.source) && l.source !== s.source));
  const unique = [...new Set(links.map((l) => l.source))];
  if (!unique.length) return;
  const batch = splitBatch(await translateText(ctx, unique.join('\n\n')), unique.length);
  const translated = new Map<string, string>();
  for (const [i, text] of unique.entries()) {
    const out = batch ? batch[i] : await translateText(ctx, text);
    if (!isRefusal(text, out)) translated.set(text, stripAddedPeriod(text, out));
  }
  for (const link of links) link.target = translated.get(link.source);
}

const looksWrong = (source: string, out: string) => !out || suspiciousLength(source, out) || hasRepetition(out) || isRefusal(source, out);

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
  const all = toUnits(ctx, segments, order);
  // Čísla a značky bez písmen ani text v grafech a schématech se nepřekládají; v PDF zůstanou původní.
  for (const u of all) if (u.seg.figure || !/\p{L}/u.test(u.prepared)) u.translation = u.prepared;
  const units = all.filter((u) => u.translation === undefined);
  const total = segments.reduce((n, s) => n + s.source.length, 0);
  let done = 0;
  const report = (chars: number) => {
    done += chars;
    ctx.progress({ stage: 'translate', done, total, eta: eta.remaining('translate', done, total) });
  };
  await ensureModel(ctx.settings.models.translate, ID.translate);
  report(0);
  const tasks: (() => Promise<void>)[] = [
    () => translateLinks(ctx, segments),
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
          if (isRefusal(u.prepared, u.translation)) {
            u.translation = u.prepared;
            addNotes(u.seg, [t('pipeline.keptOriginal')]);
          } else if (looksWrong(u.prepared, u.translation)) addNotes(u.seg, [t('pipeline.mayBeIncomplete')]);
        }
      }
      report(items.reduce((n, u) => n + u.source.length, 0));
    }),
  ];
  await eachParallel(tasks, PARALLEL, (task) => task());
  for (const seg of segments) {
    if (seg.kind !== 'table') seg.translation = stripAddedPeriod(seg.source, joinUnits(all, seg, (u) => u.translation ?? ''));
  }
}

// ---------- Kontext, kontrola a oprava ----------

const addJobNote = (job: Job, note: string) => (job.notes ??= []).push(note);

/** Téma, autor a termíny z úvodu dokumentu (Gemma); při chybě se pokračuje bez kontextu. */
async function readContext(ctx: JobContext, segments: Segment[], eta: Eta): Promise<DocumentContext | undefined> {
  const { settings, job } = ctx;
  ctx.progress({ stage: 'context', done: 0, total: 0, eta: eta.remaining('context', 0, 0) });
  const sample = segments
    .filter((s) => s.kind !== 'table' && !s.layoutOnly)
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
  if (!context) addJobNote(job, t('pipeline.noContext'));
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
    addJobNote(ctx.job, t('pipeline.spellSkipped', { error: (err as Error).message }));
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
        addJobNote(job, t('pipeline.spellInterrupted', { error: (err as Error).message }));
        return items.map(() => []);
      }
    },
  };
}

async function checkAll(ctx: JobContext, segments: Segment[], r: Reviewer, eta: Eta) {
  // Citáty jen pro přeložené PDF se nekontrolují ani neopravují.
  const todo = segments.filter((s) => s.kind !== 'table' && !s.layoutOnly);
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
      { role: 'user', content: fixUser(seg.source, before, issues.map((i) => (cs ? i.cs : i.en)), job.targetLang) },
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

function detectLanguage(text: string) {
  const code = detect(text.slice(0, 6000));
  return isSupported(code) ? code : 'en';
}

// Rozpoznaný jazyk = cílový: nejspíš vybraný už přeložený soubor, překlad by jen zabral čas.
function rejectSameLanguage(job: Job, detected: string) {
  if (detected === job.targetLang) throw new Error(t('pipeline.alreadyTarget', { lang: languageName(detected) }));
}

export async function runJob(ctx: JobContext): Promise<Measured> {
  const { job, settings, store } = ctx;
  const measured: Measured = {};
  const translating = () => job.sourceLang !== job.targetLang;
  const eta = new Eta(settings.rates, { ocrPages: 0, chars: 0, context: job.mode === 'quality' && !job.context, fixes: 0 });

  ctx.progress({ stage: 'prepare', done: 0, total: 0 });
  await ensureServer(settings.apiUrl);

  ctx.progress({ stage: 'extract', done: 0, total: 0 });
  let tick = Date.now();
  let segments: Segment[];
  if (job.resume) {
    // Pokračování po výběru odstavců: PDF se znovu nečte, jen se načte geometrie stránek.
    segments = await store.segments(job.id);
    if (job.ext.toLowerCase() === '.pdf') ctx.pages = await pageGeometries(store, job, segments);
  } else {
    segments = await extract(ctx, store.inputPath(job), eta);
    if (!segments.length) throw new Error(t('pipeline.noText'));
    if (ctx.ocrCount) measured.ocrPerPage = (Date.now() - tick) / 1000 / ctx.ocrCount;
    job.chars = segments.reduce((n, s) => n + s.source.length, 0);
    if (job.sourceLang === 'auto') {
      job.sourceLang = detectLanguage(segments.map((s) => s.source).join('\n'));
      rejectSameLanguage(job, job.sourceLang);
    }
    if (job.pickParagraphs) {
      await store.saveSegments(job.id, segments);
      return { ...measured, paused: true };
    }
  }
  const todo = pendingSegments(segments);
  const chars = todo.reduce((n, s) => n + s.source.length, 0);
  const reviewable = todo.filter((s) => s.kind !== 'table' && !s.layoutOnly).length;
  eta.setPlan({ chars, fixes: job.mode === 'fast' ? 0 : Math.round(reviewable * FIX_SHARE) });

  if (!translating()) {
    for (const s of todo) s.translation = s.source;
  } else if (todo.length) {
    // Kvalitní: Gemma (kontext) → TranslateGemma (překlad) → kontrola bez modelu → Gemma (opravy).
    if (job.mode === 'quality' && !job.context) job.context = await readContext(ctx, segments.filter((s) => !s.skipped), eta);
    tick = Date.now();
    await translateAll(ctx, todo, eta);
    // Pár odstavců by odhad zkreslilo načtením modelu.
    if (chars >= 3000) measured.translatePerKChar = (Date.now() - tick) / chars;
  }
  applyDeterministic(todo, job.targetLang);

  if (translating() && todo.length) {
    const speller = job.targetLang === 'cs' ? await startSpeller(ctx) : undefined;
    try {
      const r = reviewer(ctx, speller);
      const found = await checkAll(ctx, todo, r, eta);
      if (job.mode !== 'fast' && found.size) {
        eta.setPlan({ fixes: found.size });
        tick = Date.now();
        await fixAll(ctx, found, r, eta);
        measured.fixPerSegment = (Date.now() - tick) / 1000 / found.size;
      }
      for (const [seg, issues] of found) addNotes(seg, issues.map((i) => i.text));
    } finally {
      // Ukončení workeru uvolní ~380 MB slovníku.
      await speller?.terminate();
    }
  }

  for (const seg of todo) {
    if (!seg.links) continue;
    const found = findAnchors(finalText(seg), seg.links, seg.source);
    addNotes(seg, seg.links.filter((_, i) => !found[i]).map((l) => t('pipeline.linkNotFound', { link: l.source })));
  }

  ctx.progress({ stage: 'write', done: 0, total: 0 });
  if (job.resume) clearLayoutNotes(job, segments);
  const dir = store.jobDir(job.id);
  job.output = outputName(job);
  await writeFile(path.join(dir, job.output), await buildDocx(job.name, segments));
  await writeFile(path.join(dir, job.output.replace(/\.docx$/, '.md')), segmentsToMarkdown(segments));
  if (job.ext.toLowerCase() === '.pdf' && settings.layoutPdf && ctx.pages) await writeLayoutPdf(ctx, segments, ctx.pages);
  job.warnings = segments.filter((s) => s.warning).length;
  await store.saveSegments(job.id, segments);
  return measured;
}

/** Stránka vykreslená v pdf.js jako RGBA (nativeImage vrací pixely v pořadí BGRA). */
async function pageImage(docId: string, page: number, noText: boolean): Promise<PageImage> {
  const image = nativeImage.createFromDataURL(await renderPage(docId, page, BACKGROUND_SCALE, undefined, noText));
  const { width, height } = image.getSize();
  const data = new Uint8Array(image.toBitmap());
  for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]];
  return { width, height, data };
}

/** Přeložené PDF se zachovaným vzhledem; chyba úlohu neshodí, .docx už je uložený. */
async function writeLayoutPdf(ctx: JobContext, segments: Segment[], pages: Map<number, PageGeometry>) {
  const { job, store } = ctx;
  ctx.progress({ stage: 'layout', done: 0, total: 0 });
  const docId = `${job.id}-layout`;
  const input = new Uint8Array(await readFile(store.inputPath(job)));
  try {
    // Původní dokument zavřel extractPdf; kvůli barvě pozadí se otevře znovu.
    await openPdf(docId, input.slice());
    const result = await buildLayoutPdf(input, segments, pages, {
      fontsDir: path.join(__dirname, 'fonts'),
      pageImage: (page, noText) => pageImage(docId, page, noText),
      text: finalText,
      lang: job.targetLang,
    });
    for (const [seg, numbers] of result.overflow) {
      addNotes(seg, numbers.map((n) => t('pipeline.noFit', { page: n })));
    }
    if (result.rotated.length) {
      addJobNote(job, t('pipeline.rotated', { count: result.rotated.length, pages: result.rotated.join(', ') }));
    }
    const name = outputPdfName(job);
    await writeFile(path.join(store.jobDir(job.id), name), result.pdf);
    job.outputPdf = name;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    addJobNote(job, t('pipeline.layoutFailed', { error: (err as Error).message }));
  } finally {
    await closePdf(docId);
  }
}

/** Výřez a otočení stránek, na kterých leží segmenty (bez čtení obsahu stránek). */
async function pageGeometries(store: Store, job: Job, segments: Segment[]) {
  const numbers = [...new Set(segments.flatMap((s) => s.rects?.map((r) => r.page) ?? []))].sort((a, b) => a - b);
  const pages = new Map<number, PageGeometry>();
  const docId = `${job.id}-geometry`;
  await openPdf(docId, new Uint8Array(await readFile(store.inputPath(job))));
  try {
    for (const p of numbers) pages.set(p, geometry(await pageText(docId, p)));
  } finally {
    await closePdf(docId);
  }
  return pages;
}

// Dřívější hlášky z vysázení (v češtině i angličtině) se smažou, nové se přidají znovu.
function clearLayoutNotes(job: Job, segments: Segment[]) {
  const old = [messagePattern('pipeline.noFit')];
  for (const s of segments) {
    if (!s.warning) continue;
    s.warning = old.reduce((w, re) => w.replace(re, ''), s.warning).replace(/\s+/g, ' ').trim() || undefined;
  }
  const oldNotes = [messagePattern('pipeline.rotated'), messagePattern('pipeline.layoutFailed')];
  job.notes = job.notes?.filter((n) => !oldNotes.some((re) => new RegExp(`^${re.source}$`).test(n)));
  if (!job.notes?.length) delete job.notes;
}

/** Znovu vytvoří přeložené PDF z hotového překladu, bez modelu. */
export async function relayoutJob(store: Store, job: Job, settings: Settings) {
  if (job.ext.toLowerCase() !== '.pdf') return;
  const segments = await store.segments(job.id);
  const pages = await pageGeometries(store, job, segments);
  clearLayoutNotes(job, segments);
  const ctx: JobContext = { job, settings, glossary: [], store, signal: new AbortController().signal, progress: () => {}, pages };
  await writeLayoutPdf(ctx, segments, pages);
  job.warnings = segments.filter((s) => s.warning).length;
  await store.saveSegments(job.id, segments);
  await store.saveJob(job);
}

// Výřez se vykreslí zhruba na tuto šířku v pixelech, aby model přečetl i drobné popisky.
const REGION_PIXELS = 1600;

/** Oblast stránky přepsaná a přeložená vision modelem; stejná oblast se podruhé vezme z study.json. */
export async function translateRegion(store: Store, job: Job, settings: Settings, page: number, crop: RegionTranslation['crop']) {
  const area = normalizeCrop(crop);
  const regions = await store.regions(job.id);
  const saved = findRegion(regions, page, area);
  if (saved) return saved;
  if (!(await isVisionModel(settings.models.polish))) throw new Error(t('study.noVision', { model: settings.models.polish }));
  await ensureServer(settings.apiUrl);
  const docId = `${job.id}-study`;
  await openPdf(docId, new Uint8Array(await readFile(store.inputPath(job))));
  let image: string;
  try {
    const { width } = await pageText(docId, page);
    const scale = Math.min(6, Math.max(2, REGION_PIXELS / (width * (area[2] - area[0]))));
    image = await renderPage(docId, page, scale, area);
  } finally {
    await closePdf(docId);
  }
  await ensureModel(settings.models.polish, ID.polish);
  const text = await chat(
    settings.apiUrl,
    ID.polish,
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: regionPrompt(job.targetLang) }] }],
    { maxTokens: 3000 },
  );
  const region: RegionTranslation = { page, crop: area, text, createdAt: Date.now() };
  await store.saveRegions(job.id, [...regions, region]);
  return region;
}
