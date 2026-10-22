import type { TextItem } from '../shared/pdf';
import type { Rect, Segment, SegmentKind } from '../shared/types';

export interface Block {
  kind: SegmentKind;
  text: string;
  page?: number;
  /** Umístění na stránce z OCR (0–999) vůči obrázku stránky. */
  box?: [number, number, number, number];
  rects?: Rect[];
  fontSize?: number;
  serif?: boolean;
  bold?: boolean;
  centered?: boolean;
  /** Jen pro přeložené PDF, ve Srovnání ani v exportu se nezobrazí. */
  layoutOnly?: boolean;
  /** Tabulka z OCR přišla bez buněk (LM Studio zahazuje tokeny <tr>/<td> DeepSeek-OCR). */
  needsRepair?: boolean;
  warning?: string;
}

const LIST_LINE = /^\s*([-*•–]|\d+[.)])\s+/;
const SKIPPED_OCR_LABELS = /^(header|footer|page[_-]?(number|header|footer)|image|figure|picture)$/i;

export function markdownToBlocks(md: string, page?: number): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.split(/\n\s*\n/)) {
    const text = raw.trim();
    if (!text || /^<!--.*-->$/s.test(text)) continue;
    const lines = text.split('\n');
    const heading = text.match(/^#{1,6}\s+(.+)$/s);
    if (heading && lines.length === 1) blocks.push({ kind: 'heading', text: heading[1].trim(), page });
    else if (lines.every((l) => l.trim().startsWith('|'))) blocks.push({ kind: 'table', text, page });
    else if (lines.every((l) => LIST_LINE.test(l))) blocks.push({ kind: 'list', text, page });
    else blocks.push({ kind: 'paragraph', text: lines.map((l) => l.trim()).join(' '), page });
  }
  return blocks;
}

/** OCR modely vracejí LaTeX zápis i u obyčejného textu („\(18\%\)“). */
function cleanOcrText(text: string) {
  return text
    .replace(/\\\((.*?)\\\)/g, '$1')
    .replace(/\\([%$&#_])/g, '$1')
    .trim();
}

function htmlTableToMarkdown(html: string): string | null {
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, '').replace(/\|/g, '/').trim(),
    ),
  );
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

/**
 * Výstup Unlimited-OCR (DeepSeek-OCR) má řádky „title [x1, y1, x2, y2]Text“.
 * Jiné vision modely vracejí obyčejný Markdown, ten se zpracuje jako Markdown.
 */
export function parseOcr(output: string, page: number, size?: { width: number; height: number }): Block[] {
  const lines = output.split('\n').filter((l) => l.trim());
  const labelled = /^(\w+) \[([\d.,\s]+)\](.*)$/;
  if (!lines.length || lines.filter((l) => labelled.test(l)).length < lines.length / 2) {
    return markdownToBlocks(output, page);
  }
  const blocks: Block[] = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(labelled);
    if (!m) {
      // Pokračování předchozího bloku (např. víceřádková tabulka).
      if (!skipping && blocks.length) blocks[blocks.length - 1].text += `\n${line}`;
      continue;
    }
    const [, label, coords, content] = m;
    skipping = SKIPPED_OCR_LABELS.test(label);
    if (skipping) continue;
    const text = cleanOcrText(content);
    if (!text) continue;
    const numbers = coords.split(',').map(Number);
    const box = numbers.length === 4 && numbers.every(Number.isFinite) ? (numbers as Block['box']) : undefined;
    if (/^title$|heading/i.test(label)) blocks.push({ kind: 'heading', text: text.replace(/^#+\s*/, ''), page, box });
    else if (/table/i.test(label)) blocks.push({ kind: 'table', text, page, box });
    else blocks.push(...splitBox(markdownToBlocks(text, page), box));
  }
  if (size) for (const block of blocks) Object.assign(block, ocrGeometry(block, size));
  for (const block of blocks) {
    if (block.kind === 'table' && /<table/i.test(block.text)) {
      const md = htmlTableToMarkdown(block.text);
      if (md) block.text = md;
      else {
        block.text = unstructuredTable(block.text);
        block.needsRepair = true;
      }
    }
  }
  return blocks;
}

/** Víc bloků z jednoho štítku OCR si rozdělí jeho výšku podle délky textu. */
function splitBox(blocks: Block[], box: Block['box']): Block[] {
  if (!box || blocks.length < 2) return blocks.map((b) => ({ ...b, box }));
  const [x0, y0, x1, y1] = box;
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  let top = y0;
  return blocks.map((b) => {
    const bottom = top + ((y1 - y0) * b.text.length) / total;
    const part = { ...b, box: [x0, Math.round(top), x1, Math.round(bottom)] as Block['box'] };
    top = bottom;
    return part;
  });
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Typické písmo bloku z plochy: znak zabere zhruba 0,5 × 1,2 velikosti písma. */
function estimateFontSize(w: number, h: number, chars: number) {
  return Math.min(h, Math.sqrt((w * h) / (0.6 * Math.max(1, chars))));
}

/** Box z OCR (0–999 vůči obrázku stránky) na obdélník v bodech stránky. */
export function ocrGeometry(block: Block, size: { width: number; height: number }): Pick<Block, 'rects' | 'fontSize' | 'bold'> {
  if (!block.box || block.page === undefined) return {};
  const [x0, y0, x1, y1] = block.box.map((v) => Math.min(999, Math.max(0, v)) / 999);
  const rect: Rect = {
    page: block.page,
    x: round(x0 * size.width),
    y: round(y0 * size.height),
    w: round((x1 - x0) * size.width),
    h: round((y1 - y0) * size.height),
    chars: block.text.length,
  };
  if (rect.w <= 0 || rect.h <= 0) return {};
  // Tabulka má mezi buňkami hodně volného místa, odhad z plochy by vyšel velký.
  const fontSize = estimateFontSize(rect.w, rect.h, block.text.length) * (block.kind === 'table' ? 0.6 : 1);
  return { rects: [rect], fontSize: round(fontSize), bold: block.kind === 'heading' };
}

/** Text tabulky bez hranic buněk; mezery se odhadnou na přechodech „slovoSlovo“ a „slovo123“. */
function unstructuredTable(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{L})/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown tabulka od vision modelu: spojí zalomené řádky a ověří, že má hlavičku a data. */
export function normalizeMarkdownTable(text: string): string | null {
  const rows: string[] = [];
  for (const raw of text.replace(/```\w*/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('|') || !rows.length) rows.push(line);
    else rows[rows.length - 1] += ` ${line}`;
  }
  const table = rows.filter((r) => r.startsWith('|')).map((r) => (r.endsWith('|') ? r : `${r} |`));
  const separator = table.findIndex((r) => /^\|[\s|:-]+\|$/.test(r));
  if (table.length < 3 || separator !== 1) return null;
  return table.join('\n');
}

interface Line {
  y: number;
  h: number;
  x0: number;
  x1: number;
  /** Úseky řádku oddělené velkou mezerou (sloupce tabulky), aby překrytí nesmazalo čáry mezi nimi. */
  spans: [number, number][];
  text: string;
  serif: boolean;
  bold: boolean;
}

/** Převažující vlastnost podle počtu znaků. */
function majority<T extends { str?: string; text?: string }>(list: T[], test: (t: T) => boolean | undefined) {
  const len = (t: T) => (t.str ?? t.text ?? '').length;
  const yes = list.filter(test).reduce((n, t) => n + len(t), 0);
  return yes * 2 > list.reduce((n, t) => n + len(t), 0);
}

function toLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; h: number; items: TextItem[] }[] = [];
  for (const item of sorted) {
    const line = lines.find((l) => Math.abs(l.y - item.y) < Math.max(l.h, item.h) * 0.5);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, h: item.h, items: [item] });
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) => {
      const parts = line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let end = -Infinity;
      const spans: [number, number][] = [];
      for (const p of parts) {
        const gap = p.x - end;
        if (text && !text.endsWith(' ') && !p.str.startsWith(' ') && gap > p.h * 0.1) text += ' ';
        text += p.str;
        if (spans.length && gap < p.h) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], p.x + p.w);
        else spans.push([p.x, p.x + p.w]);
        end = Math.max(end, p.x + p.w);
      }
      return {
        y: line.y,
        h: Math.max(...parts.map((p) => p.h)),
        x0: Math.min(...parts.map((p) => p.x)),
        x1: Math.max(...parts.map((p) => p.x + p.w)),
        spans,
        text: text.replace(/\s+/g, ' ').trim(),
        serif: majority(parts, (p) => p.serif),
        bold: majority(parts, (p) => p.bold),
      };
    })
    .filter((l) => l.text);
}

// Dolní medián: u pár řádků by horní medián vzal mezeru mezi odstavci za běžné řádkování.
function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

interface Metrics {
  bodyHeight: number;
  lineGap: number;
  pageWidth: number;
}

function metrics(lines: Line[], pageWidth: number): Metrics {
  const bodyHeight = median(lines.map((l) => l.h));
  const gaps = lines.slice(1).map((l, i) => l.y - lines[i].y);
  return { bodyHeight, lineGap: median(gaps.filter((g) => g > 0)) || bodyHeight * 1.2, pageWidth };
}

// Metriky se berou z celé stránky: skupina nad sloupci (název článku) by jinak sama sebe brala za běžný text.
function linesToBlocks(lines: Line[], page: number, { bodyHeight, lineGap, pageWidth }: Metrics): Block[] {
  if (!lines.length) return [];
  const blocks: Block[] = [];
  const members = new Map<Block, Line[]>();
  let current: Block | null = null;
  lines.forEach((line, i) => {
    const isHeading = line.h > bodyHeight * 1.1 && line.text.length < 150;
    const prev = lines[i - 1];
    const gap = i ? line.y - prev.y : Infinity;
    const isList = LIST_LINE.test(line.text);
    // Dvouřádkový nadpis (stejné písmo, těsně pod sebou) zůstane jedním nadpisem; zvýrazněný citát
    // mívá větší řádkování, ale pokračování začíná malým písmenem.
    const headingContinues =
      isHeading &&
      current?.kind === 'heading' &&
      Math.abs(prev.h - line.h) < 0.5 &&
      (gap < line.h * 1.6 || (/^\p{Ll}/u.test(line.text) && gap < line.h * 3));
    const startsNew =
      !headingContinues &&
      (!current || isHeading || current.kind === 'heading' || gap > lineGap * 1.5 || (isList && current.kind !== 'list'));
    if (startsNew) {
      current = { kind: isHeading ? 'heading' : isList ? 'list' : 'paragraph', text: line.text, page };
      blocks.push(current);
      members.set(current, [line]);
      return;
    }
    members.get(current!)!.push(line);
    if (current!.kind === 'list' && isList) {
      current!.text += `\n${line.text}`;
    } else if (/[\p{L}]-$/u.test(current!.text) && /^\p{Ll}/u.test(line.text)) {
      current!.text = current!.text.slice(0, -1) + line.text; // rozdělené slovo na konci řádku
    } else {
      current!.text += ` ${line.text}`;
    }
  });
  for (const block of blocks) Object.assign(block, lineGeometry(members.get(block)!, page, block, pageWidth));
  return blocks;
}

/** Obálka řádků bloku; dolní okraj včetně dotažnic (účaří je na y + h). */
function lineGeometry(lines: Line[], page: number, block: Block, pageWidth: number): Pick<Block, 'rects' | 'fontSize' | 'serif' | 'bold' | 'centered'> {
  const top = Math.min(...lines.map((l) => l.y));
  const bottom = Math.max(...lines.map((l) => l.y + l.h * 1.2));
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const cover = lines.flatMap((l) => l.spans.map(([a, b]) => [round(a), round(l.y), round(b - a), round(l.h * 1.2)] as [number, number, number, number]));
  const rect: Rect = { page, x: round(x0), y: round(top), w: round(x1 - x0), h: round(bottom - top), chars: block.text.length, cover };
  // Na střed: víc řádků se stejným středem a různým začátkem, nebo jeden kratší řádek uprostřed stránky.
  const centers = lines.map((l) => (l.x0 + l.x1) / 2);
  const centered =
    lines.length > 1
      ? Math.max(...centers) - Math.min(...centers) < 3 && Math.max(...lines.map((l) => l.x0)) - x0 > 6
      : Math.abs(centers[0] - pageWidth / 2) < pageWidth * 0.01 && x1 - x0 < pageWidth * 0.7;
  return {
    rects: [rect],
    fontSize: round(median(lines.map((l) => l.h))),
    serif: majority(lines, (l) => l.serif),
    bold: block.kind === 'heading' || majority(lines, (l) => l.bold),
    ...(centered && { centered }),
  };
}

/**
 * Bloky z OCR na digitální stránce: písmo, typ a plochy řádků podle textové vrstvy pod boxem
 * (velikost odhadnutá z boxu bývá nepřesná a celý box by překryl i čáry tabulky).
 */
export function textLayerGeometry(blocks: Block[], items: TextItem[], pageWidth: number) {
  const real = items.filter((i) => i.str.trim());
  for (const block of blocks) {
    const rect = block.rects?.[0];
    if (!rect || block.rects!.length > 1) continue;
    const inside = real.filter((i) => {
      const cx = i.x + i.w / 2;
      const cy = i.y + i.h / 2;
      return cx >= rect.x - 3 && cx <= rect.x + rect.w + 3 && cy >= rect.y - 3 && cy <= rect.y + rect.h + 3;
    });
    const lines = toLines(inside);
    if (!lines.length) continue;
    const { rects, ...style } = lineGeometry(lines, rect.page, block, pageWidth);
    Object.assign(block, style, { rects: [{ ...rects![0], chars: rect.chars }] });
  }
}

/**
 * Textová vrstva PDF → bloky. Dvousloupcové stránky se čtou po sloupcích,
 * jinak by se řádky obou sloupců prolínaly.
 */
export function layoutToBlocks(items: TextItem[], pageWidth: number, page: number): Block[] {
  const real = items.filter((i) => i.str.trim());
  if (!real.length) return [];
  const mid = pageWidth / 2;
  const tolerance = pageWidth * 0.02;
  const left = real.filter((i) => i.x + i.w <= mid + tolerance);
  const right = real.filter((i) => i.x >= mid - tolerance);
  const spanning = real.filter((i) => !left.includes(i) && !right.includes(i));
  const chars = (list: TextItem[]) => list.reduce((n, i) => n + i.str.length, 0);
  const total = chars(real);
  const twoColumns = chars(left) > total * 0.25 && chars(right) > total * 0.25 && chars(spanning) < total * 0.3;
  const pageMetrics = metrics(toLines(twoColumns ? left : real), pageWidth);
  if (!twoColumns) return linesToBlocks(toLines(real), page, pageMetrics);

  const columnsTop = Math.min(...[...left, ...right].map((i) => i.y));
  const above = spanning.filter((i) => i.y < columnsTop);
  const below = spanning.filter((i) => i.y >= columnsTop);
  return [above, left, right, below].flatMap((group) => linesToBlocks(toLines(group), page, pageMetrics));
}

/**
 * Záhlaví a zápatí: krátký text na stejném místě na více stránkách (lišta webu, název časopisu)
 * a samotná čísla stránek u horního nebo dolního okraje.
 */
export function removePageFurniture(pages: { items: TextItem[]; height: number }[]): TextItem[][] {
  const key = (i: TextItem) => `${i.str.trim()}|${Math.round(i.y / 4)}`;
  const seen = new Map<string, Set<number>>();
  pages.forEach((p, n) => {
    for (const i of p.items) {
      if (!i.str.trim() || i.str.trim().length > 60) continue;
      if (!seen.has(key(i))) seen.set(key(i), new Set());
      seen.get(key(i))!.add(n);
    }
  });
  const repeated = (i: TextItem) => pages.length > 1 && (seen.get(key(i))?.size ?? 0) >= Math.max(2, pages.length / 2);
  return pages.map((p) =>
    p.items.filter((i) => {
      const nearEdge = i.y < p.height * 0.07 || i.y > p.height * 0.93;
      return !repeated(i) && !(nearEdge && /^\s*\d{1,3}\s*$/.test(i.str));
    }),
  );
}

/** Stejné krátké bloky na většině stránek (záhlaví z OCR) se zahodí. */
export function dropRepeatedBlocks(blocks: Block[]): Block[] {
  const pages = new Set(blocks.map((b) => b.page)).size;
  if (pages < 2) return blocks;
  const onPages = new Map<string, Set<number | undefined>>();
  for (const b of blocks) {
    if (b.text.length > 60) continue;
    if (!onPages.has(b.text)) onPages.set(b.text, new Set());
    onPages.get(b.text)!.add(b.page);
  }
  return blocks.filter((b) => (onPages.get(b.text)?.size ?? 0) < Math.max(2, pages / 2));
}

const SENTENCE_END = /[.!?:;…"”'’)\]]$/;

/**
 * Odstavec rozdělený koncem stránky se spojí. Jinak by se obě půlky překládaly zvlášť
 * a model by první dokončil vymyšleným koncem.
 */
export function mergeAcrossPages(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === 'paragraph' &&
      b.kind === 'paragraph' &&
      prev.page !== undefined &&
      b.page === prev.page + 1 &&
      // Krátký řádek bez tečky (hashtag, podpis) není useknutý odstavec.
      prev.text.length >= 80 &&
      !SENTENCE_END.test(prev.text.trim())
    ) {
      prev.text = /\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(b.text) ? prev.text.slice(0, -1) + b.text : `${prev.text} ${b.text}`;
      if (b.warning) prev.warning ??= b.warning;
      joinRects(prev, b);
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

/** Nadpis rozdělený na dva bloky (pokračování začíná malým písmenem) se spojí, typicky citát z OCR. */
export function mergeBrokenHeadings(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev?.kind === 'heading' && b.kind === 'heading' && prev.page === b.page && /^\p{Ll}/u.test(b.text)) {
      prev.text = `${prev.text} ${b.text}`;
      joinRects(prev, b);
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

function joinRects(into: Block, from: Block) {
  if (into.rects || from.rects) into.rects = [...(into.rects ?? []), ...(from.rects ?? [])];
}

const normalized = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

/**
 * Zvýrazněný citát opakuje větu z článku; ve Srovnání a exportu by byl dvakrát.
 * Blok, jehož text je celý obsažený v jiném bloku, se přeloží jen pro přeložené PDF
 * (u shody zůstane viditelný odstavec, ne nadpis).
 */
export function markDuplicateBlocks(blocks: Block[]): Block[] {
  const norms = blocks.map((b) => normalized(b.text));
  return blocks.map((b, i) => {
    if (norms[i].length < 40 || b.kind === 'table') return b;
    const duplicate = norms.some((other, j) => {
      if (j === i || !other.includes(norms[i])) return false;
      if (other.length > norms[i].length) return true;
      // Stejný text: skrýt nadpis před odstavcem, u stejného druhu pozdější výskyt.
      return blocks[j].kind === b.kind ? j < i : b.kind === 'heading';
    });
    return duplicate ? { ...b, layoutOnly: true } : b;
  });
}

/** TranslateGemma přidává tečku i za nadpis nebo položku bez tečky. */
export function stripAddedPeriod(source: string, translation: string) {
  return !/[.!?…]$/.test(source.trim()) && /[^.]\.$/.test(translation.trim()) ? translation.trim().slice(0, -1) : translation;
}

export function blocksToSegments(blocks: Block[]): Segment[] {
  // Samotné symboly (☰, ikony z webu) nejsou text k překladu.
  return blocks
    .filter((b) => /[\p{L}\p{N}]/u.test(b.text))
    .map((b, id) => ({
      id,
      kind: b.kind,
      page: b.page,
      source: b.text,
      ...(b.warning && { warning: b.warning }),
      ...(b.rects?.length && { rects: b.rects, fontSize: b.fontSize, serif: b.serif, bold: b.bold, centered: b.centered }),
      ...(b.layoutOnly && { layoutOnly: true }),
    }));
}

/** Indexy segmentů seskupené do dávek pro překlad; tabulky jdou samostatně. */
export function groupSegments(segments: Segment[], maxChars: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let size = 0;
  for (const [i, s] of segments.entries()) {
    if (s.kind === 'table' || s.source.length > maxChars) {
      if (current.length) groups.push(current);
      groups.push([i]);
      current = [];
      size = 0;
      continue;
    }
    if (current.length && size + s.source.length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += s.source.length + 2;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Rozdělí dlouhý odstavec po větách na části do `max` znaků (věta se nikdy nedělí). */
export function sentenceChunks(text: string, max: number): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+(?=[\p{Lu}\d"„“(])/u);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + sentence.length + 1 <= max) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}

/** Rozdělí přeloženou dávku zpět na segmenty; null, když model sloučil nebo rozdělil odstavce. */
export function splitBatch(text: string, expected: number): string[] | null {
  // Jediný odstavec v dávce: že ho model rozdělil na dva, nevadí.
  if (expected === 1) return text.trim() ? [text.trim().replace(/\s*\n\s*\n\s*/g, ' ')] : null;
  const parts = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length === expected ? parts : null;
}

export const finalText = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? s.source;

/** Segmenty pro Srovnání, Překlad a export (bez těch, které jsou jen pro přeložené PDF). */
export const visibleSegments = (segments: Segment[]) => segments.filter((s) => !s.layoutOnly);

export function segmentsToMarkdown(segments: Segment[], text: (s: Segment) => string = finalText): string {
  return visibleSegments(segments)
    .map((s) => (s.kind === 'heading' ? `## ${text(s).replace(/^#+\s*/, '')}` : text(s)))
    .join('\n\n');
}
