import type { TextItem } from '../shared/pdf';
import type { Segment, SegmentKind } from '../shared/types';

export interface Block {
  kind: SegmentKind;
  text: string;
  page?: number;
  /** Umístění na stránce z OCR (0–999), u tabulek pro jejich opravu z výřezu obrázku. */
  box?: [number, number, number, number];
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
export function parseOcr(output: string, page: number): Block[] {
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
    if (/^title$|heading/i.test(label)) blocks.push({ kind: 'heading', text: text.replace(/^#+\s*/, ''), page });
    else if (/table/i.test(label)) {
      const box = coords.split(',').map(Number);
      blocks.push({ kind: 'table', text, page, box: box.length === 4 ? (box as Block['box']) : undefined });
    }
    else blocks.push(...markdownToBlocks(text, page));
  }
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
  text: string;
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
      for (const p of parts) {
        const gap = p.x - end;
        if (text && !text.endsWith(' ') && !p.str.startsWith(' ') && gap > p.h * 0.1) text += ' ';
        text += p.str;
        end = p.x + p.w;
      }
      return { y: line.y, h: Math.max(...parts.map((p) => p.h)), text: text.replace(/\s+/g, ' ').trim() };
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
}

function metrics(lines: Line[]): Metrics {
  const bodyHeight = median(lines.map((l) => l.h));
  const gaps = lines.slice(1).map((l, i) => l.y - lines[i].y);
  return { bodyHeight, lineGap: median(gaps.filter((g) => g > 0)) || bodyHeight * 1.2 };
}

// Metriky se berou z celé stránky: skupina nad sloupci (název článku) by jinak sama sebe brala za běžný text.
function linesToBlocks(lines: Line[], page: number, { bodyHeight, lineGap }: Metrics): Block[] {
  if (!lines.length) return [];
  const blocks: Block[] = [];
  let current: Block | null = null;
  lines.forEach((line, i) => {
    const isHeading = line.h > bodyHeight * 1.1 && line.text.length < 150;
    const prev = lines[i - 1];
    const gap = i ? line.y - prev.y : Infinity;
    const isList = LIST_LINE.test(line.text);
    // Dvouřádkový nadpis (stejné písmo, těsně pod sebou) zůstane jedním nadpisem.
    const headingContinues =
      isHeading && current?.kind === 'heading' && Math.abs(prev.h - line.h) < 0.5 && gap < line.h * 1.6;
    const startsNew =
      !headingContinues &&
      (!current || isHeading || current.kind === 'heading' || gap > lineGap * 1.5 || (isList && current.kind !== 'list'));
    if (startsNew) {
      current = { kind: isHeading ? 'heading' : isList ? 'list' : 'paragraph', text: line.text, page };
      blocks.push(current);
    } else if (current!.kind === 'list' && isList) {
      current!.text += `\n${line.text}`;
    } else if (/[\p{L}]-$/u.test(current!.text) && /^\p{Ll}/u.test(line.text)) {
      current!.text = current!.text.slice(0, -1) + line.text; // rozdělené slovo na konci řádku
    } else {
      current!.text += ` ${line.text}`;
    }
  });
  return blocks;
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
  const pageMetrics = metrics(toLines(twoColumns ? left : real));
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
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

/** TranslateGemma přidává tečku i za nadpis nebo položku bez tečky. */
export function stripAddedPeriod(source: string, translation: string) {
  return !/[.!?…]$/.test(source.trim()) && /[^.]\.$/.test(translation.trim()) ? translation.trim().slice(0, -1) : translation;
}

export function blocksToSegments(blocks: Block[]): Segment[] {
  // Samotné symboly (☰, ikony z webu) nejsou text k překladu.
  return blocks.filter((b) => /[\p{L}\p{N}]/u.test(b.text)).map((b, id) => ({ id, kind: b.kind, page: b.page, source: b.text, ...(b.warning && { warning: b.warning }) }));
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

export function segmentsToMarkdown(segments: Segment[], text: (s: Segment) => string = finalText): string {
  return segments
    .map((s) => (s.kind === 'heading' ? `## ${text(s).replace(/^#+\s*/, '')}` : text(s)))
    .join('\n\n');
}
