import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, popGraphicsState, pushGraphicsState, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Rect, Segment } from '../shared/types';

/** Výřez a otočení stránky z pdf.js; rozměry viewportu při scale 1. */
export interface PageGeometry {
  view: [number, number, number, number];
  rotate: number;
  width: number;
  height: number;
  /** Neviditelná textová vrstva (OCR nad skenem). */
  invisible?: boolean;
}

/** Vykreslená stránka, pixely RGBA po řádcích. */
export interface PageImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Measure = (text: string, size: number) => number;
type Color = [number, number, number];
type Box = Pick<Rect, 'x' | 'y' | 'w' | 'h'>;

const LINE = 1.2;
const MIN_SCALE = 0.7;
// Tabulka nesmí přetéct do textu pod ní, proto se smí zmenšit víc než odstavec.
const TABLE_MIN_SCALE = 0.5;
const STEP = 0.05;
// Plocha přes původní text je o kousek větší, aby nezůstaly okraje písmen.
const PAD = 1.5;
// Řádek pixelů se počítá jako obsazený od tohoto počtu odlišných pixelů (šum obrázků).
const INK_PIXELS = 2;
// Prázdné místo musí mít barvu pozadí skoro přesně, aby se text nedostal přes okraj jemně odlišné plochy.
const BLANK_TOLERANCE = 8;
// Nejvýš tolik bodů pod odstavcem smí překlad využít, než se začne zmenšovat písmo.
const MAX_ROOM = 40;
const FONT_FILES = {
  sans: 'NotoSans-Regular.ttf',
  sansBold: 'NotoSans-Bold.ttf',
  serif: 'NotoSerif-Regular.ttf',
  serifBold: 'NotoSerif-Bold.ttf',
};

/** Obdélník viewportu pdf.js (počátek vlevo nahoře) do souřadnic PDF (počátek vlevo dole, s posunem cropBox). */
export function toPdfRect(r: Box, view: PageGeometry['view']) {
  return { x: view[0] + r.x, y: view[3] - r.y - r.h, width: r.w, height: r.h };
}

/** Zalomení po slovech; `\n` je pevný konec řádku (položky seznamu). */
export function wrapText(text: string, width: number, size: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Výška textu od horního okraje po dotažnice posledního řádku. */
export const textHeight = (lines: number, size: number) => (lines ? (lines - 1) * LINE * size + 1.05 * size : 0);

export interface Fitted {
  lines: string[];
  size: number;
  fits: boolean;
}

/**
 * Největší velikost od `start` dolů po 5 % (nejvýš na 70 %), při které se text vejde; jinak nejmenší s přesahem.
 * `wider`: širší místo, které se zkusí v každé velikosti dřív, než se písmo zmenší.
 */
export function fitText(text: string, box: Pick<Box, 'w' | 'h'>, start: number, measure: Measure, wider?: number): Fitted {
  let last: Fitted = { lines: [], size: start, fits: false };
  const widths = wider && wider > box.w ? [box.w, wider] : [box.w];
  for (let scale = 1; scale >= MIN_SCALE - 1e-9; scale -= STEP) {
    const size = start * scale;
    for (const width of widths) {
      const lines = wrapText(text, width, size, measure);
      const fits = textHeight(lines.length, size) <= box.h + 0.5 && lines.every((l) => measure(l, size) <= width + 0.5);
      last = { lines, size, fits };
      if (fits) return last;
    }
  }
  return last;
}

/** Rozdělí text mezi obdélníky v poměru vah (délka zdroje), vždy na hranici slova. */
export function splitText(text: string, weights: number[]): string[] {
  if (weights.length < 2) return [text.trim()];
  const shares = weights.some((w) => w > 0) ? weights : weights.map(() => 1);
  const total = shares.reduce((n, w) => n + w, 0);
  const parts: string[] = [];
  let start = 0;
  let acc = 0;
  for (const weight of shares.slice(0, -1)) {
    acc += weight;
    const target = Math.round((text.length * acc) / total);
    let cut = text.length;
    for (let d = 0; d <= text.length; d++) {
      const after = target + d;
      const before = target - d;
      if (after < text.length && after >= start && /\s/.test(text[after])) {
        cut = after;
        break;
      }
      if (before > start && before < text.length && /\s/.test(text[before])) {
        cut = before;
        break;
      }
    }
    parts.push(text.slice(start, cut).trim());
    start = cut;
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Buňky Markdown tabulky bez oddělovacího řádku. */
export function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) =>
      l
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    );
}

export interface FittedTable {
  size: number;
  widths: number[];
  rows: string[][][];
  fits: boolean;
}

const CELL_PAD = 2;
const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

/** Šířky sloupců: nejdelší slovo se vždy vejde, zbytek místa podle délky obsahu. */
function columnWidths(rows: string[][], cols: number, total: number, size: number, measure: Measure) {
  const columns = Array.from({ length: cols }, (_, c) => rows.map((r) => r[c] ?? ''));
  const min = columns.map((cells) => Math.max(0, ...cells.flatMap((t) => t.split(/\s+/).map((w) => measure(w, size)))) + CELL_PAD * 2);
  const want = columns.map((cells, c) => Math.max(min[c], ...cells.map((t) => measure(t, size) + CELL_PAD * 2)));
  if (sum(want) <= total) return { widths: want.map((w) => (w * total) / sum(want)), wordsFit: true };
  if (sum(min) >= total) return { widths: min.map((w) => (w * total) / sum(min)), wordsFit: sum(min) <= total + 0.5 };
  const flex = sum(want) - sum(min);
  return { widths: min.map((m, c) => m + ((total - sum(min)) * (want[c] - m)) / flex), wordsFit: true };
}

/** Začátky sloupců originálu podle úseků řádků; null, když jich není stejně jako sloupců tabulky. */
export function columnStarts(rect: Pick<Rect, 'x' | 'w' | 'cover'>, cols: number): number[] | null {
  const xs = [...(rect.cover ?? []).map(([x]) => x)].sort((a, b) => a - b).filter((x, i, all) => !i || x - all[i - 1] > 3);
  return xs.length === cols && cols > 1 ? xs : null;
}

/**
 * Mřížka podle počtu sloupců: buňky zalomené ve svém sloupci, řádky pod sebou, zmenšování do 70 %.
 * `starts`: začátky sloupců originálu (x vůči obdélníku), pak se šířky nepočítají.
 */
export function fitTable(
  rows: string[][],
  box: Pick<Box, 'w' | 'h'>,
  start: number,
  measure: Measure,
  starts?: number[],
  rooms?: number[],
  minScale = TABLE_MIN_SCALE,
): FittedTable {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  let last: FittedTable = { size: start, widths: [], rows: [], fits: false };
  const fixed = starts?.length === cols ? starts.map((x, c) => (c + 1 < cols ? starts[c + 1] : box.w) - x) : undefined;
  for (let scale = 1; scale >= minScale - 1e-9; scale -= STEP) {
    const size = start * scale;
    const measured = columnWidths(rows, cols, box.w, size, measure);
    const widths = fixed ?? measured.widths;
    const wordsFit = fixed ? rows.every((r) => r.every((cell, c) => cell.split(/\s+/).every((w) => measure(w, size) + CELL_PAD * 2 <= fixed[c] + 0.5))) : measured.wordsFit;
    const wrapped = rows.map((r) => widths.map((w, c) => wrapText(r[c] ?? '', Math.max(1, w - CELL_PAD * 2), size, measure)));
    const height = wrapped.reduce((n, r) => n + Math.max(1, ...r.map((cell) => cell.length)) * LINE * size, 0);
    // `rooms`: výška řádků originálu, do které se má vejít každý řádek zvlášť.
    const rowsFit = !rooms || wrapped.every((r, i) => Math.max(1, ...r.map((cell) => cell.length)) * LINE * size <= rooms[i] + 0.5);
    last = { size, widths, rows: wrapped, fits: wordsFit && rowsFit && height <= box.h + 0.5 };
    if (last.fits) break;
  }
  return last;
}

/** Začátky řádků tabulky originálu (y viewportu) podle větších mezer mezi řádky textu. */
export function rowStarts(rect: Pick<Rect, 'cover'>): number[] {
  const ys = [...new Set((rect.cover ?? []).map(([, y]) => y))].sort((a, b) => a - b).filter((y, i, all) => !i || y - all[i - 1] > 2);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]);
  const step = Math.min(...gaps);
  return ys.filter((_, i) => !i || gaps[i - 1] > step * 1.5);
}

/** Horní okraje řádků, když se nedrží řádků originálu: volné místo se rozdělí podle výšky řádků. */
export function spreadRows(rect: Pick<Rect, 'y' | 'h'>, heights: number[]): number[] {
  const total = sum(heights);
  const extra = Math.max(0, rect.h - total);
  let y = rect.y;
  return heights.map((h) => {
    const top = y;
    y += h + (total ? (extra * h) / total : 0);
    return top;
  });
}

/** Medián barvy pixelů na obvodu obdélníku (v pixelech obrázku); 0–1 na kanál. */
export function backgroundColor(image: PageImage, box: Box): Color {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width - 1, Math.ceil(box.x + box.w));
  const y1 = Math.min(image.height - 1, Math.ceil(box.y + box.h));
  if (x1 < x0 || y1 < y0) return [1, 1, 1];
  const channels: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    for (let c = 0; c < 3; c++) channels[c].push(image.data[i + c]);
  };
  for (let x = x0; x <= x1; x++) {
    take(x, y0);
    take(x, y1);
  }
  for (let y = y0 + 1; y < y1; y++) {
    take(x0, y);
    take(x1, y);
  }
  return channels.map((values) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] / 255;
  }) as Color;
}

const luminance = ([r, g, b]: Color) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Tabulka má v originálu čáru nahoře nebo dole (většina pixelů okraje je tmavá); pak se mřížka po překrytí nakreslí znovu. */
export function hasRuledEdges(image: PageImage, box: Box): boolean {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.min(image.width - 1, Math.ceil(box.x + box.w));
  if (x1 <= x0) return false;
  const darkRow = (y: number) => {
    if (y < 0 || y >= image.height) return 0;
    let dark = 0;
    for (let x = x0; x <= x1; x++) {
      const i = (y * image.width + x) * 4;
      if (luminance([image.data[i] / 255, image.data[i + 1] / 255, image.data[i + 2] / 255]) < 0.5) dark++;
    }
    return dark / (x1 - x0 + 1);
  };
  // Čára bývá těsně u okraje rámečku z OCR, zkouší se pár řádků pixelů dovnitř i ven.
  const edge = (y: number) => Math.max(...[-3, -2, -1, 0, 1, 2, 3].map((d) => darkRow(Math.round(y) + d)));
  return edge(box.y) > 0.6 || edge(box.y + box.h) > 0.6;
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined;
};

/** Podíl pixelů, které se ve dvou vykresleních liší (text je vidět, když ho vykreslení bez textu nemá). */
export function inkDifference(a: PageImage, b: PageImage, box: Box): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(a.width, b.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(a.height, b.height, Math.ceil(box.y + box.h));
  let total = 0;
  let different = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      total++;
      if (Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]) > 60) different++;
    }
  }
  return total ? different / total : 0;
}

/** Řádek pixelů, na kterém ve dvou vykresleních poprvé vzniká text (jinak null). */
function firstInkRow(a: PageImage, b: PageImage, box: Box): number | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.min(a.width, b.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(a.height, b.height, Math.ceil(box.y + box.h));
  for (let y = Math.max(0, Math.floor(box.y)); y < y1; y++) {
    let different = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      if (Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]) > 60 && ++different >= INK_PIXELS) return y;
    }
  }
  return null;
}

/** Výška (v bodech) prázdného pásu pod obdélníkem: řádky pixelů stejné barvy jako pozadí, nejvýš MAX_ROOM. */
export function blankBelow(image: PageImage, rect: Box, color: Color, px: number): number {
  const x0 = Math.max(0, Math.floor(rect.x * px));
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.w) * px));
  const start = Math.ceil((rect.y + rect.h + PAD) * px);
  const end = Math.min(image.height, start + Math.ceil(MAX_ROOM * px));
  const [r, g, b] = color.map((v) => v * 255);
  let y = start;
  for (; y < end; y++) {
    let different = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      if (Math.abs(image.data[i] - r) + Math.abs(image.data[i + 1] - g) + Math.abs(image.data[i + 2] - b) > BLANK_TOLERANCE && ++different >= INK_PIXELS) break;
    }
    if (different >= INK_PIXELS) break;
  }
  return Math.max(0, (y - start) / px);
}

// Písmo Noto nemá všechny symboly; řídicí znaky a tabulátory by pdf-lib vypsal jako prázdné glyfy.
const clean = (text: string) => text.replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f­​-‏﻿]/g, '');

export interface LayoutOptions {
  fontsDir: string;
  /** Vykreslená stránka (s textem a bez něj) pro barvu pozadí a viditelnost textu. */
  pageImage(page: number, noText: boolean): Promise<PageImage>;
  text(segment: Segment): string;
}

export interface LayoutResult {
  pdf: Uint8Array;
  /** Segment → stránky, na kterých se překlad nevešel do původního místa. */
  overflow: Map<Segment, number[]>;
  /** Otočené stránky, které zůstaly beze změny. */
  rotated: number[];
}

/** Obsah stránky obalený q/Q, aby neuzavřený stav grafiky originálu nepohnul vepsaným textem. */
function isolate(doc: PDFDocument, page: PDFPage) {
  page.node.normalize();
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

// Viditelný text změní aspoň pár procent pixelů svého řádku.
const VISIBLE_INK = 0.01;

interface Placement {
  segment: Segment;
  rect: Rect;
  color: Color;
  /** Tabulka měla čáry, které překrytí smazalo. */
  ruled: boolean;
  /** Pravý okraj sloupce, kam smí jednořádkový text přesáhnout. */
  right: number;
  /** Prázdné místo (body) pod obdélníkem, které smí odstavec využít, než zmenší písmo. */
  room: number;
  text: string;
}

/**
 * Viditelná část obdélníku z textové vrstvy: řádky schované pod jiným obsahem (lišta webu při tisku) se vynechají.
 * Neviditelná textová vrstva nad skenem se překrývá celá, text je vidět v obrázku.
 */
export function visiblePart(rect: Rect, geometry: PageGeometry, full: PageImage, bare: PageImage): Rect | null {
  // Obdélník z OCR (bez ploch řádků) pochází z obrázku stránky, je tedy vidět.
  if (geometry.invisible || !rect.cover) return rect;
  const px = full.width / geometry.width;
  const boxes = rect.cover;
  const shown = boxes.filter(([x, y, w, h]) => inkDifference(full, bare, { x: x * px, y: y * px, w: w * px, h: h * px }) >= VISIBLE_INK);
  if (!shown.length) return null;
  if (shown.length === boxes.length) return rect;
  let top = Math.min(...shown.map(([, y]) => y));
  const bottom = Math.max(...shown.map(([, y, , h]) => y + h));
  // Řádky nad prvním viditelným jsou pod lištou webu: text i plocha začnou až u prvních pixelů písma pod ní,
  // aby překlad nepřekryl okraj lišty.
  const hiddenAbove = boxes.some(([, y]) => y < top);
  const first = hiddenAbove ? shown.find(([, y]) => y === top) : undefined;
  if (first) {
    const ink = firstInkRow(full, bare, { x: first[0] * px, y: first[1] * px, w: first[2] * px, h: first[3] * px });
    const start = ink === null ? top : ink / px;
    if (start - top > PAD) {
      top = start + PAD;
      const clipped: [number, number, number, number] = [first[0], top, first[2], Math.max(0, first[1] + first[3] - top)];
      return { ...rect, y: top, h: bottom - top, cover: shown.map((box) => (box === first ? clipped : box)) };
    }
  }
  return { ...rect, y: top, h: bottom - top, cover: shown };
}

export async function buildLayoutPdf(input: Uint8Array, segments: Segment[], pages: Map<number, PageGeometry>, options: LayoutOptions): Promise<LayoutResult> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = new Map<keyof typeof FONT_FILES, PDFFont>();
  const font = async (key: keyof typeof FONT_FILES) => {
    if (!fonts.has(key)) fonts.set(key, await doc.embedFont(await readFile(path.join(options.fontsDir, FONT_FILES[key])), { subset: true }));
    return fonts.get(key)!;
  };
  const overflow = new Map<Segment, number[]>();
  const rotated = new Set<number>();
  const usable = (rect: Rect) => {
    const geometry = pages.get(rect.page);
    if (!geometry || rect.page > doc.getPageCount() || rect.w <= 0 || rect.h <= 0) return false;
    if (geometry.rotate % 360 === 0) return true;
    rotated.add(rect.page);
    return false;
  };
  const items = segments
    .map((segment) => ({ segment, rects: segment.rects?.filter(usable) ?? [], text: clean(options.text(segment)).trim() }))
    .filter((i) => i.rects.length && i.text);

  // Viditelnost a barva pozadí stránku po stránce (vykreslení se hned zahodí).
  const shown = new Map<Rect, { rect: Rect; color: Color; ruled: boolean; room: number }>();
  for (const number of [...new Set(items.flatMap((i) => i.rects.map((r) => r.page)))].sort((a, b) => a - b)) {
    const geometry = pages.get(number)!;
    const full = await options.pageImage(number, false);
    const bare = geometry.invisible ? full : await options.pageImage(number, true);
    const px = full.width / geometry.width;
    for (const rect of items.flatMap((i) => i.rects).filter((r) => r.page === number)) {
      const visible = visiblePart(rect, geometry, full, bare);
      if (!visible) continue;
      const box = { x: (visible.x - PAD) * px, y: (visible.y - PAD) * px, w: (visible.w + PAD * 2) * px, h: (visible.h + PAD * 2) * px };
      const table = items.some((i) => i.segment.kind === 'table' && i.rects.includes(rect));
      const color = backgroundColor(full, box);
      const flowing = items.some((i) => ['paragraph', 'list'].includes(i.segment.kind) && i.rects.includes(rect));
      shown.set(rect, {
        rect: visible,
        color,
        ruled: table && !rect.cover && hasRuledEdges(full, { x: rect.x * px, y: rect.y * px, w: rect.w * px, h: rect.h * px }),
        room: flowing ? blankBelow(full, visible, color, px) : 0,
      });
    }
  }

  const byPage = new Map<number, Placement[]>();
  for (const { segment, rects, text } of items) {
    const visible = rects.filter((r) => shown.has(r));
    if (!visible.length) continue;
    const parts = segment.kind === 'table' ? [text, ...visible.slice(1).map(() => '')] : splitText(text, visible.map((r) => r.chars ?? r.w * r.h));
    visible.forEach((original, i) => {
      const { rect, color, ruled, room } = shown.get(original)!;
      if (!byPage.has(rect.page)) byPage.set(rect.page, []);
      byPage.get(rect.page)!.push({ segment, rect, color, ruled, right: rect.x + rect.w, room, text: parts[i] });
    });
  }

  for (const [number, placements] of byPage) {
    const geometry = pages.get(number)!;
    const page = doc.getPage(number - 1);
    isolate(doc, page);
    // Sloupec: obdélníky na stejné stránce začínající na stejném x.
    for (const p of placements) {
      p.right = Math.max(p.right, ...placements.filter((o) => Math.abs(o.rect.x - p.rect.x) < 6).map((o) => o.rect.x + o.rect.w));
    }
    // Nejdřív všechny plochy, pak text: plocha sousedního bloku nesmí překrýt už vepsaný překlad.
    for (const { rect, color } of placements) {
      for (const [x, y, w, h] of rect.cover ?? [[rect.x, rect.y, rect.w, rect.h]]) {
        const r = toPdfRect({ x: x - PAD, y: y - PAD, w: w + PAD * 2, h: h + PAD * 2 }, geometry.view);
        page.drawRectangle({ ...r, color: rgb(...color), borderWidth: 0 });
      }
    }
    // Odhad velikosti písma z OCR kolísá blok od bloku; odstavce na stránce se drží kolem mediánu.
    const bodySize = median(placements.filter((p) => p.segment.kind === 'paragraph' && p.segment.fontSize).map((p) => p.segment.fontSize!));
    for (const { segment, rect, color: background, ruled, right, room, text } of placements) {
      if (!text) continue;
      const color = luminance(background) < 0.5 ? rgb(1, 1, 1) : rgb(0, 0, 0);
      const regular = await font(segment.serif ? 'serif' : 'sans');
      const bold = await font(segment.serif ? 'serifBold' : 'sansBold');
      const main = segment.bold || segment.kind === 'heading' ? bold : regular;
      const top = geometry.view[3] - rect.y;
      const x = geometry.view[0] + rect.x;
      const own = segment.fontSize ?? bodySize ?? 10;
      const size = segment.kind === 'paragraph' && bodySize ? Math.min(Math.max(own, bodySize * 0.9), bodySize * 1.1) : own;
      let fits: boolean;
      if (segment.kind === 'table') {
        const rows = tableRows(text);
        const start = Math.min(size, rect.h / Math.max(1, rows.length) / LINE);
        const grid = rows.length ? rows : [[text]];
        const measure: Measure = (t, s) => bold.widthOfTextAtSize(t, s);
        // Nejradši do sloupců i řádků originálu, pak jen do sloupců, nakonec s vlastními šířkami.
        const columns = columnStarts(rect, Math.max(...grid.map((r) => r.length)))?.map((sx) => sx - rect.x);
        const anchors = rowStarts(rect);
        const rooms = anchors.length === grid.length ? anchors.map((y, i) => (anchors[i + 1] ?? rect.y + rect.h) - y) : undefined;
        const attempts: [number[] | undefined, number[] | undefined][] = [[columns, rooms], [columns, undefined], [undefined, undefined]];
        let table = fitTable(grid, rect, start, measure, ...attempts[0]);
        let [starts, anchored] = attempts[0];
        for (const [c, r] of attempts.slice(1)) {
          if (table.fits) break;
          if (c === starts && r === anchored) continue;
          const next = fitTable(grid, rect, start, measure, c, r);
          if (next.fits || !c) [table, starts, anchored] = [next, c, r];
        }
        fits = table.fits;
        const heights = table.rows.map((cells) => Math.max(1, ...cells.map((lines) => lines.length)) * LINE * table.size);
        const tops = anchored ? anchors : table.fits ? spreadRows(rect, heights) : heights.map((_, r) => rect.y + sum(heights.slice(0, r)));
        table.rows.forEach((cells, r) => {
          let cx = x + (starts?.[0] ?? 0);
          const y = geometry.view[3] - tops[r];
          cells.forEach((lines, c) => {
            lines.forEach((line, l) =>
              page.drawText(line, { x: cx + CELL_PAD, y: y - table.size * (0.85 + l * LINE), size: table.size, font: r === 0 ? bold : regular, color }),
            );
            cx += table.widths[c];
          });
        });
        if (ruled && table.fits) {
          const line = { thickness: 0.6, color: luminance(background) < 0.5 ? rgb(0.85, 0.85, 0.85) : rgb(0.25, 0.25, 0.25) };
          const left = x + (starts?.[0] ?? 0);
          const width = sum(table.widths);
          const bottom = geometry.view[3] - (rect.y + rect.h);
          for (const t of [...tops, rect.y + rect.h]) {
            const y = geometry.view[3] - t;
            page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, ...line });
          }
          let cx = left;
          for (const w of [0, ...table.widths]) {
            cx += w;
            page.drawLine({ start: { x: cx, y: geometry.view[3] - rect.y }, end: { x: cx, y: bottom }, ...line });
          }
        }
      } else {
        // Jednořádkový nadpis smí do volného místa ve sloupci, než by se zmenšoval.
        const single = rect.h < size * 2.2 && !segment.centered;
        // Volné místo pod odstavcem se využije dřív, než se písmo zmenší; mezera k dalšímu bloku zůstane.
        const extra = Math.max(0, room - size * 0.8);
        const fitted = fitText(text, { w: rect.w, h: rect.h + extra }, size, (t, s) => main.widthOfTextAtSize(t, s), single ? right - rect.x : undefined);
        fits = fitted.fits;
        fitted.lines.forEach((line, l) => {
          const indent = segment.centered ? Math.max(0, (rect.w - main.widthOfTextAtSize(line, fitted.size)) / 2) : 0;
          page.drawText(line, { x: x + indent, y: top - fitted.size * (0.85 + l * LINE), size: fitted.size, font: main, color });
        });
      }
      if (!fits) overflow.set(segment, [...new Set([...(overflow.get(segment) ?? []), number])]);
    }
  }
  return { pdf: await doc.save(), overflow, rotated: [...rotated].sort((a, b) => a - b) };
}
