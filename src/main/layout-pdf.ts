import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, popGraphicsState, pushGraphicsState, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { TextItem } from '../shared/pdf';
import type { Rect, Segment, SegmentLink } from '../shared/types';
import { ATTEMPTS, PAGE_ATTEMPTS, firstIndent, flow, isJustified, measuredPitch, type FlowBlock, type Frame, type Free, type PlacedLine } from './flow';
import { hyphenParts } from './hyphenate';
import { findAnchors, type AnchorRange } from './quality';
import { textPieces } from './segments';

/** Výřez a otočení stránky z pdf.js; rozměry viewportu při scale 1. */
export interface PageGeometry {
  view: [number, number, number, number];
  rotate: number;
  width: number;
  height: number;
  /** Neviditelná textová vrstva (OCR nad skenem). */
  invisible?: boolean;
  /** Textová vrstva stránky; podle ní se tabulka sází po buňkách. */
  items?: TextItem[];
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
const STEP = 0.05;
// Plocha přes původní text je o kousek větší, aby nezůstaly okraje písmen.
const PAD = 1.5;
// Řádek pixelů se počítá jako obsazený od tohoto počtu odlišných pixelů (šum obrázků).
const INK_PIXELS = 2;
// Prázdné místo musí mít barvu pozadí skoro přesně, aby se text nedostal přes okraj jemně odlišné plochy.
const BLANK_TOLERANCE = 8;
// Nejvýš tolik bodů pod odstavcem smí překlad využít, než se začne zmenšovat písmo.
const MAX_ROOM = 40;
// Plocha řádku z textové vrstvy je 1,2× výška písma (segments.ts).
const LINE_BOX = 1.2;
// Pás vlevo od bloku, kde se hledají odrážky kreslené jako grafika.
const GUTTER = 18;
const FONT_FILES = {
  sans: 'NotoSans-Regular.ttf',
  sansBold: 'NotoSans-Bold.ttf',
  serif: 'NotoSerif-Regular.ttf',
  serifBold: 'NotoSerif-Bold.ttf',
};
// Noto pro latinku nemá matematické znaky (≤ ≥ ≠ → ∞); ty se vysází záložním písmem.
const FALLBACK_FONT = 'NotoSansMath-Regular.ttf';

type Run = { text: string; font: PDFFont };

/** Písmo se záložním písmem pro znaky, které hlavní písmo nemá. */
export class TextFont {
  constructor(
    private main: PDFFont,
    private covers: (code: number) => boolean,
    private fallback?: PDFFont,
  ) {}

  runs(text: string): Run[] {
    const runs: Run[] = [];
    for (const char of text) {
      const font = this.fallback && !this.covers(char.codePointAt(0)!) ? this.fallback : this.main;
      const last = runs[runs.length - 1];
      if (last?.font === font) last.text += char;
      else runs.push({ text: char, font });
    }
    return runs;
  }

  widthOfTextAtSize(text: string, size: number) {
    return this.runs(text).reduce((n, run) => n + run.font.widthOfTextAtSize(run.text, size), 0);
  }

  draw(page: PDFPage, text: string, options: { x: number; y: number; size: number; color: ReturnType<typeof rgb> }) {
    let x = options.x;
    for (const run of this.runs(text)) {
      page.drawText(run.text, { ...options, x, font: run.font });
      x += run.font.widthOfTextAtSize(run.text, options.size);
    }
  }
}

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

type TextPiece = ReturnType<typeof textPieces>[number];

// Zvýraznění z Markdownu (**Celkem**, *Zdroj*) a LaTeX z OCR ($\leq$) se do PDF nekreslí.
const LATEX: Record<string, string> = { leq: '≤', geq: '≥', le: '≤', ge: '≥', times: '×', pm: '±', neq: '≠', approx: '≈', cdot: '·' };
const plainCell = (text: string) =>
  text
    .replace(/\$?\\(leq|geq|le|ge|times|pm|neq|approx|cdot)\b\$?/g, (_, name: string) => LATEX[name])
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)\*(\S[^*]*\S|\S)\*(?=\s|$)/g, '$1$2')
    .trim();
// Párování jen podle písmen: matematické znaky mívá textová vrstva rozbité („≤“ jako řídicí znak, „>“ jako „4“).
const letters = (text: string) => (plainCell(text).toLowerCase().match(/\p{L}+/gu) ?? []).join('');

/**
 * Buňky tabulky jako samostatné bloky na místě textu originálu (vzor BabelDOC): mřížka, čáry
 * a čísla zůstanou, přeloží se jen buňky s písmeny. Buňka se v textové vrstvě najde podle písmen;
 * zalomená buňka se poskládá z úseků pod sebou ve stejném sloupci, úseky bez písmen (čísla, znaky)
 * přímo pod ní k ní patří. Nenalezená buňka zůstane původní. Obdélník buňky sahá k sousední buňce
 * vpravo a dolů; kolik z toho se smí využít, rozhodne sazba podle obrázku stránky.
 */
export function tableCells(segment: Segment, translation: string, items: TextItem[]): Segment[] {
  const rect = segment.rects?.[0];
  const source = tableRows(segment.source);
  const target = tableRows(translation);
  if (!rect || source.length !== target.length || source.some((row, r) => row.length !== target[r].length)) return [];
  const inside = (p: TextPiece) => {
    const cx = (p.x0 + p.x1) / 2;
    const cy = p.y + p.h / 2;
    return cx >= rect.x - 3 && cx <= rect.x + rect.w + 3 && cy >= rect.y - 3 && cy <= rect.y + rect.h + 3;
  };
  const pieces = textPieces(items)
    .filter(inside)
    .sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const used = new Set<TextPiece>();
  // Další řádek téže buňky: těsně pod posledním úsekem a začíná u jejího levého okraje (nanejvýš odsazený).
  // Číslo pod širokou buňkou (název panelu přes celou tabulku) patří do dalšího řádku tabulky.
  const below = (group: TextPiece[], q: TextPiece) => {
    const last = group[group.length - 1];
    const x0 = Math.min(...group.map((p) => p.x0));
    const x1 = Math.max(...group.map((p) => p.x1));
    return !used.has(q) && !group.includes(q) && q.y > last.y + last.h * 0.3 && q.y < last.y + last.h * 1.6 && q.x0 >= x0 - last.h && q.x0 < Math.min(x1, x0 + last.h * 3);
  };
  const find = (key: string) => {
    for (const start of pieces) {
      if (used.has(start) || !letters(start.text) || !key.startsWith(letters(start.text))) continue;
      const group = [start];
      let acc = letters(start.text);
      while (acc !== key) {
        const next = pieces.find((q) => below(group, q) && key.startsWith(acc + letters(q.text)));
        if (!next) break;
        group.push(next);
        acc += letters(next.text);
      }
      if (acc !== key) continue;
      for (let tail = pieces.find((q) => below(group, q) && !letters(q.text)); tail; tail = pieces.find((q) => below(group, q) && !letters(q.text))) group.push(tail);
      return group;
    }
    return undefined;
  };
  const found: { group: TextPiece[]; source: string; text: string }[] = [];
  source.forEach((row, r) =>
    row.forEach((cell, c) => {
      const text = plainCell(target[r][c]);
      const key = letters(cell);
      if (!key || letters(text) === key) return;
      const group = find(key);
      if (!group) return;
      group.forEach((p) => used.add(p));
      found.push({ group, source: plainCell(cell), text });
    }),
  );
  return found.map(({ group, source: cellSource, text }) => {
    const x0 = Math.min(...group.map((p) => p.x0));
    const x1 = Math.max(...group.map((p) => p.x1));
    const y0 = Math.min(...group.map((p) => p.y));
    const y1 = Math.max(...group.map((p) => p.y + p.h * LINE_BOX));
    const h = median(group.map((p) => p.h)) ?? 8;
    const others = pieces.filter((p) => !group.includes(p));
    const right = Math.min(rect.x + rect.w, ...others.filter((p) => p.x0 >= x1 - 1 && p.y < y1 && p.y + p.h > y0).map((p) => p.x0 - h * 0.6));
    const bottom = Math.min(rect.y + rect.h, ...others.filter((p) => p.y >= y1 - h * 0.5 && p.x0 < right && p.x1 > x0).map((p) => p.y - h * 0.15));
    const top = Math.max(rect.y, ...others.filter((p) => p.y + p.h <= y0 + h * 0.5 && p.x0 < right && p.x1 > x0).map((p) => p.y + p.h * LINE_BOX));
    return {
      ...segment,
      kind: 'table' as const,
      source: cellSource,
      translation: text,
      polished: undefined,
      edited: undefined,
      links: undefined,
      fontSize: h,
      serif: majority(group.map((p) => p.serif)) ?? segment.serif,
      rects: [{ page: rect.page, x: x0, y: Math.min(y0, top), w: Math.max(x1, right) - x0, h: Math.max(y1, bottom) - Math.min(y0, top), cover: group.map((p) => [p.x0, p.y, p.x1 - p.x0, p.h * LINE_BOX] as [number, number, number, number]) }],
    };
  });
}

const majority = (values: (boolean | undefined)[]) => {
  const known = values.filter((v): v is boolean => v !== undefined);
  return known.length ? known.filter(Boolean).length * 2 >= known.length : undefined;
};

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

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

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

/** Výška (v bodech) prázdného pásu pod obdélníkem: řádky pixelů stejné barvy jako pozadí, nejvýš `max`. */
export function blankBelow(image: PageImage, rect: Box, color: Color, px: number, max = MAX_ROOM): number {
  const x0 = Math.max(0, Math.floor(rect.x * px));
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.w) * px));
  const start = Math.ceil((rect.y + rect.h + PAD) * px);
  const end = Math.min(image.height, start + Math.ceil(max * px));
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

export interface LinkStyle {
  /** Barva odkazu, když se liší od běžného (šedého) písma. */
  color?: Color;
  underline: boolean;
}

/** Barva a podtržení odkazu z vykreslené stránky: medián barvy písma v klikací ploše a řádek pixelů přes celou šířku písma. */
export function linkStyle(image: PageImage, box: Box): LinkStyle {
  const [br, bg, bb] = backgroundColor(image, box).map((v) => v * 255);
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.h));
  const ink: { rgb: number[]; distance: number }[] = [];
  const rows = new Map<number, number>();
  let left = Infinity;
  let right = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const distance = Math.abs(image.data[i] - br) + Math.abs(image.data[i + 1] - bg) + Math.abs(image.data[i + 2] - bb);
      if (distance < 150) continue;
      ink.push({ rgb: [image.data[i], image.data[i + 1], image.data[i + 2]], distance });
      rows.set(y, (rows.get(y) ?? 0) + 1);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  if (!ink.length) return { underline: false };
  // Vyhlazené okraje písma barvu zesvětlují, proto jen sytější polovina pixelů.
  const solid = ink.sort((a, b) => b.distance - a.distance).slice(0, Math.ceil(ink.length / 2));
  const color = [0, 1, 2].map((c) => median(solid.map((p) => p.rgb[c]))! / 255) as Color;
  const colorful = Math.max(...color) - Math.min(...color) > 0.2;
  const middle = (y0 + y1) / 2;
  const underline = [...rows].some(([y, n]) => y > middle && n >= (right - left + 1) * 0.8);
  return { ...(colorful && { color }), underline };
}

/** V obdélníku (pixely obrázku) je něco jiného než pozadí. */
export function hasInk(image: PageImage, box: Box, color: Color): boolean {
  const [r, g, b] = color.map((v) => v * 255);
  let different = 0;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(image.height, Math.ceil(box.y + box.h)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(image.width, Math.ceil(box.x + box.w)); x++) {
      const i = (y * image.width + x) * 4;
      if (Math.abs(image.data[i] - r) + Math.abs(image.data[i + 1] - g) + Math.abs(image.data[i + 2] - b) > 60 && ++different >= INK_PIXELS * 4) return true;
    }
  }
  return false;
}

/**
 * Grafika vlevo od řádků bloku (odrážky a čísla kreslené jako obrázek): pás před začátkem každého řádku.
 * Podtržení odkazů leží pod textem, do pásu nezasahuje.
 */
function gutterInk(bare: PageImage, rect: Rect, color: Color, px: number): boolean {
  const starts = new Map<number, [number, number]>();
  for (const [x, y, , h] of rect.cover ?? [[rect.x, rect.y, rect.w, rect.h]]) {
    const row = starts.get(Math.round(y));
    if (!row || x < row[0]) starts.set(Math.round(y), [x, h]);
  }
  return [...starts].some(([y, [x, h]]) => {
    const left = rect.x - GUTTER;
    return x - PAD - 1 > left && hasInk(bare, { x: left * px, y: y * px, w: (x - PAD - 1 - left) * px, h: h * px }, color);
  });
}

/**
 * Plochy původního textu k přemalování; u odkazů i jejich klikací plocha, aby nezůstalo podtržení
 * (překlad je jinde než původní text odkazu).
 */
function coverBoxes({ rect, segment }: Placement): [number, number, number, number][] {
  const boxes: [number, number, number, number][] = [...(rect.cover ?? [[rect.x, rect.y, rect.w, rect.h]])];
  if (segment.kind === 'table') return boxes;
  for (const link of segment.links ?? []) {
    for (const r of link.rects) {
      const inside = r.page === rect.page && r.y >= rect.y - PAD && r.y + r.h <= rect.y + rect.h + PAD * 3;
      if (inside) boxes.push([r.x, r.y, r.w, r.h]);
    }
  }
  return boxes;
}

/** Kopie stránky bez textu s přemalovanými plochami původního textu (grafika pod nimi, např. podtržení, zmizí i v PDF). */
function paintCovers(image: PageImage, placements: Placement[], geometry: PageGeometry): PageImage {
  const data = image.data.slice();
  const px = image.width / geometry.width;
  for (const placement of placements) {
    const [r, g, b] = placement.color.map((v) => Math.round(v * 255));
    for (const [x, y, w, h] of coverBoxes(placement)) {
      for (let yy = Math.max(0, Math.floor((y - PAD) * px)); yy < Math.min(image.height, Math.ceil((y + h + PAD) * px)); yy++) {
        for (let xx = Math.max(0, Math.floor((x - PAD) * px)); xx < Math.min(image.width, Math.ceil((x + w + PAD) * px)); xx++) {
          const i = (yy * image.width + xx) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
      }
    }
  }
  return { ...image, data };
}

/** Barva písma: medián sytější poloviny pixelů odlišných od pozadí (vyhlazené okraje písmo zesvětlují). */
export function inkColor(image: PageImage, box: Box): Color | undefined {
  const [br, bg, bb] = backgroundColor(image, box).map((v) => v * 255);
  const ink: { rgb: number[]; distance: number }[] = [];
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(image.height, Math.ceil(box.y + box.h)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(image.width, Math.ceil(box.x + box.w)); x++) {
      const i = (y * image.width + x) * 4;
      const distance = Math.abs(image.data[i] - br) + Math.abs(image.data[i + 1] - bg) + Math.abs(image.data[i + 2] - bb);
      if (distance >= 150) ink.push({ rgb: [image.data[i], image.data[i + 1], image.data[i + 2]], distance });
    }
  }
  if (ink.length < 10) return undefined;
  const solid = ink.sort((a, b) => b.distance - a.distance).slice(0, Math.ceil(ink.length / 2));
  return [0, 1, 2].map((c) => median(solid.map((p) => p.rgb[c]))! / 255) as Color;
}

/** Pro každé slovo textu (dělení podle mezer jako ve wrapText) index odkazu u každého znaku. */
export function wordMarks(text: string, ranges: (AnchorRange | null)[]): (number | undefined)[][] {
  return [...text.matchAll(/\S+/g)].map((m) =>
    Array.from(m[0], (_, c) => {
      const at = m.index + c;
      const link = ranges.findIndex((r) => r && at >= r.start && at < r.end);
      return link < 0 ? undefined : link;
    }),
  );
}

/** Řádek rozdělený na úseky stejného odkazu; mezera patří odkazu, jen když je uvnitř něj. */
export function lineRuns(words: string[], marks: (number | undefined)[][]): { text: string; link?: number }[] {
  const runs: { text: string; link?: number }[] = [];
  const push = (text: string, link: number | undefined) => {
    const last = runs[runs.length - 1];
    if (last && last.link === link) last.text += text;
    else runs.push(link === undefined ? { text } : { text, link });
  };
  words.forEach((word, i) => {
    const own = marks[i] ?? [];
    if (i) {
      const before = (marks[i - 1] ?? [])[words[i - 1].length - 1];
      push(' ', before !== undefined && before === own[0] ? before : undefined);
    }
    for (let c = 0; c < word.length; c++) push(word[c], own[c]);
  });
  return runs;
}

// Písmo Noto nemá všechny symboly; řídicí znaky a tabulátory by pdf-lib vypsal jako prázdné glyfy.
const clean = (text: string) => text.replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f­​-‏﻿]/g, '');

export interface LayoutOptions {
  fontsDir: string;
  /** Vykreslená stránka (s textem a bez něj) pro barvu pozadí a viditelnost textu. */
  pageImage(page: number, noText: boolean): Promise<PageImage>;
  text(segment: Segment): string;
  /** Jazyk překladu (dělení slov). */
  lang?: string;
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

export interface Placement {
  segment: Segment;
  rect: Rect;
  color: Color;
  /** Pravý okraj sloupce, kam smí jednořádkový text přesáhnout. */
  right: number;
  /** Prázdné místo (body) pod obdélníkem, které smí odstavec využít, než zmenší písmo. */
  room: number;
  /** Vzdálenost k dalšímu obsahu pod obdélníkem (text, obrázek, čára). */
  below: number;
  /** Barva písma originálu. */
  ink?: Color;
  /** Vlevo od textu je grafika (odrážky, čísla kreslená jako obrázek): blok zůstane na svém místě. */
  anchored: boolean;
  text: string;
  /** Pořadí prvního slova části v celém textu segmentu (index do `marks`). */
  firstWord: number;
  marks: (number | undefined)[][];
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

/**
 * PDF se zákazem úprav (šifrované bez hesla k otevření, např. MIT SMR) pdf-lib nenačte;
 * fork @cantoo/pdf-lib ho umí rozšifrovat prázdným heslem.
 */
export async function decryptPdf(input: Uint8Array): Promise<Uint8Array> {
  const probe = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false });
  if (!probe.isEncrypted) return input;
  const { PDFDocument: Decrypting } = await import('@cantoo/pdf-lib');
  return (await Decrypting.load(input, { password: '', updateMetadata: false })).save();
}

export async function buildLayoutPdf(input: Uint8Array, segments: Segment[], pages: Map<number, PageGeometry>, options: LayoutOptions): Promise<LayoutResult> {
  const doc = await PDFDocument.load(await decryptPdf(input), { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = new Map<keyof typeof FONT_FILES, TextFont>();
  let fallback: Promise<PDFFont | undefined> | undefined;
  const font = async (key: keyof typeof FONT_FILES) => {
    if (!fonts.has(key)) {
      const data = await readFile(path.join(options.fontsDir, FONT_FILES[key]));
      const face = fontkit.create(data);
      fallback ??= readFile(path.join(options.fontsDir, FALLBACK_FONT)).then(
        (math) => doc.embedFont(math, { subset: true }),
        () => undefined,
      );
      fonts.set(key, new TextFont(await doc.embedFont(data, { subset: true }), (code) => face.hasGlyphForCodePoint(code), await fallback));
    }
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
  // Vykreslení stránky se použije pro buňky tabulek i pro plochy, kreslí se jen jednou.
  const images = new Map<string, Promise<PageImage>>();
  const pageImage = (page: number, noText: boolean) => {
    const key = `${page}|${noText}`;
    if (!images.has(key)) images.set(key, options.pageImage(page, noText));
    return images.get(key)!;
  };
  // Tabulka se nepřekresluje: přeloží se po buňkách, které se vejdou; bez textové vrstvy zůstane původní.
  // Buňka smí doprava a dolů jen tam, kde v obrázku stránky bez textu není čára ani jiná grafika.
  const measureCell = async (cell: Segment, geometry: PageGeometry) => {
    const main = await font(fontKey(cell));
    const r = cell.rects![0];
    const cover = r.cover!;
    const x1 = Math.max(...cover.map(([x, , w]) => x + w));
    const y0 = Math.min(...cover.map(([, y]) => y));
    const y1 = Math.max(...cover.map(([, y, , h]) => y + h));
    const full = await pageImage(r.page, false);
    const bare = geometry.invisible ? undefined : await pageImage(r.page, true);
    const px = full.width / geometry.width;
    const scaled = (b: Box) => ({ x: b.x * px, y: b.y * px, w: b.w * px, h: b.h * px });
    const color = backgroundColor(full, scaled({ x: r.x, y: y0, w: x1 - r.x, h: y1 - y0 }));
    const clear = (b: Box) => b.w <= 0.5 || b.h <= 0.5 || !bare || !hasInk(bare, scaled(b), color);
    const right = clear({ x: x1 + PAD, y: y0, w: r.x + r.w - x1 - PAD, h: y1 - y0 }) ? r.x + r.w : x1;
    const bottom = clear({ x: r.x, y: y1 + PAD, w: right - r.x, h: r.y + r.h - y1 - PAD }) ? r.y + r.h : y1;
    const top = clear({ x: r.x, y: r.y, w: right - r.x, h: y0 - PAD - r.y }) ? r.y : y0;
    // Nejdřív jen do šířky, pak i pod buňku, nakonec i nad ni (záhlaví mívá volno nahoře).
    for (const [t, b] of [[y0, y1], [y0, bottom], [top, bottom]]) {
      if (!fitText(clean(cell.translation!), { w: right - r.x, h: b - t }, cell.fontSize!, (text, size) => main.widthOfTextAtSize(text, size)).fits) continue;
      cell.rects = [{ ...r, y: t, w: right - r.x, h: b - t }];
      return true;
    }
    return false;
  };
  const expanded: Segment[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'table') {
      expanded.push(segment);
      continue;
    }
    const geometry = segment.rects?.[0] && usable(segment.rects[0]) ? pages.get(segment.rects[0].page) : undefined;
    for (const cell of geometry?.items ? tableCells(segment, clean(options.text(segment)), geometry.items) : []) {
      if (await measureCell(cell, geometry!)) expanded.push(cell);
    }
  }
  const items = expanded
    .map((segment) => ({ segment, rects: stackRects(segment.rects?.filter(usable) ?? []), text: clean(options.text(segment)).trim() }))
    // Nezměněný text (čísla, ponechaný originál) zůstane v PDF tak, jak byl: jeho písmo nemusí jít znovu vysázet.
    .filter((i) => i.rects.length && i.text && !sameText(i.text, i.segment.source))
    .map((i) => ({ ...i, marks: i.segment.links && i.segment.kind !== 'table' ? wordMarks(i.text, findAnchors(i.text, i.segment.links, i.segment.source)) : [] }));
  const styles = new Map<SegmentLink, LinkStyle>();

  // Viditelnost a barva pozadí stránku po stránce (vykreslení se hned zahodí).
  const shown = new Map<Rect, { rect: Rect; color: Color; room: number; below: number; ink?: Color; anchored: boolean }>();
  // Stránky bez textu: kam překlad nesmí (obrázky, odrážky, čáry).
  const graphics = new Map<number, PageImage>();
  for (const number of [...new Set(items.flatMap((i) => i.rects.map((r) => r.page)))].sort((a, b) => a - b)) {
    const geometry = pages.get(number)!;
    const full = await pageImage(number, false);
    const bare = geometry.invisible ? full : await pageImage(number, true);
    if (!geometry.invisible) graphics.set(number, bare);
    const px = full.width / geometry.width;
    for (const link of items.flatMap((i) => i.segment.links ?? [])) {
      const r = link.rects.find((o) => o.page === number);
      if (r && !styles.has(link)) styles.set(link, linkStyle(full, { x: r.x * px, y: r.y * px, w: r.w * px, h: r.h * px }));
    }
    for (const rect of items.flatMap((i) => i.rects).filter((r) => r.page === number)) {
      const visible = visiblePart(rect, geometry, full, bare);
      if (!visible) continue;
      const box = { x: (visible.x - PAD) * px, y: (visible.y - PAD) * px, w: (visible.w + PAD * 2) * px, h: (visible.h + PAD * 2) * px };
      const table = items.some((i) => i.segment.kind === 'table' && i.rects.includes(rect));
      const color = backgroundColor(full, box);
      const flowing = items.some((i) => ['paragraph', 'list'].includes(i.segment.kind) && i.rects.includes(rect));
      const first = visible.cover?.[0];
      shown.set(rect, {
        rect: visible,
        color,
        room: flowing ? blankBelow(full, visible, color, px) : 0,
        below: table ? 0 : blankBelow(full, visible, color, px, geometry.height),
        ink: first && !geometry.invisible ? inkColor(full, { x: first[0] * px, y: first[1] * px, w: first[2] * px, h: first[3] * px }) : undefined,
        anchored: !table && !geometry.invisible && gutterInk(bare, visible, color, px),
      });
    }
  }

  const byPage = new Map<number, Placement[]>();
  for (const { segment, rects, text, marks } of items) {
    const visible = rects.filter((r) => shown.has(r));
    if (!visible.length) continue;
    const parts = segment.kind === 'table' ? [text, ...visible.slice(1).map(() => '')] : splitText(text, visible.map((r) => r.chars ?? r.w * r.h));
    let firstWord = 0;
    visible.forEach((original, i) => {
      const { rect, color, room, below, ink, anchored } = shown.get(original)!;
      if (!byPage.has(rect.page)) byPage.set(rect.page, []);
      byPage.get(rect.page)!.push({ segment, rect, color, right: rect.x + rect.w, room, below, ink, anchored, text: parts[i], firstWord, marks });
      firstWord += parts[i].split(/\s+/).filter(Boolean).length;
    });
  }

  // Nová místa odkazů v přeloženém textu (souřadnice PDF).
  const pieces = new Map<SegmentLink, { page: number; x: number; y: number; width: number; height: number }[]>();
  const style = await documentStyle([...byPage.values()].flat(), (serif) => font(serif ? 'serif' : 'sans'));
  const hyphenate = (word: string) => hyphenParts(word, options.lang ?? '');

  for (const [number, placements] of byPage) {
    const geometry = pages.get(number)!;
    const page = doc.getPage(number - 1);
    isolate(doc, page);
    // Sloupec: obdélníky na stejné stránce začínající na stejném x.
    // Štítek diagramu zůstane ve svém rámečku.
    // Buňka tabulky má volné místo spočítané předem, sloupec článku ji nerozšíří.
    const inColumn = (o: Placement) => !o.segment.figure && o.segment.kind !== 'table';
    for (const p of placements.filter(inColumn)) {
      p.right = Math.max(p.right, ...placements.filter((o) => inColumn(o) && Math.abs(o.rect.x - p.rect.x) < 6).map((o) => o.rect.x + o.rect.w));
    }
    // Nejdřív všechny plochy, pak text: plocha sousedního bloku nesmí překrýt už vepsaný překlad.
    for (const placement of placements) {
      const { color } = placement;
      for (const [x, y, w, h] of coverBoxes(placement)) {
        const r = toPdfRect({ x: x - PAD, y: y - PAD, w: w + PAD * 2, h: h + PAD * 2 }, geometry.view);
        page.drawRectangle({ ...r, color: rgb(...color), borderWidth: 0 });
      }
    }
    // Odhad velikosti písma z OCR kolísá blok od bloku; odstavce na stránce se drží kolem mediánu.
    const bodySize = median(placements.filter((p) => p.segment.kind === 'paragraph' && p.segment.fontSize).map((p) => p.segment.fontSize!));
    const textSize = (p: Placement) => {
      // Velikost z řádků na této stránce; odstavec slitý přes stránky může mít jinde jiné písmo.
      const lines = (p.rect.cover ?? []).map(([, , , h]) => h / LINE_BOX);
      const own = (lines.length ? median(lines) : undefined) ?? p.segment.fontSize ?? bodySize ?? 10;
      // Velikost z textové vrstvy je přesná; ke středu se táhnou jen odhady z OCR.
      return p.segment.kind === 'paragraph' && bodySize && !p.rect.cover ? Math.min(Math.max(own, bodySize * 0.9), bodySize * 1.1) : own;
    };
    const chains = pageChains(placements).map((frames) => ({ frames }));
    const flowed = new Set(chains.flatMap((c) => c.frames.flatMap((f) => f.members)));
    // Po sobě jdoucí části téhož odstavce (obtéká obrázek, pokračuje v dalším sloupci) tečou jako jeden text,
    // jinak by přetečení první části a začátek druhé oddělila mezera odstavce.
    const flowText = new Map<Placement, string>();
    for (const chain of chains) {
      let head: Placement | undefined;
      for (const p of chain.frames.flatMap((f) => f.members)) {
        if (head?.segment === p.segment) {
          flowText.set(head, `${flowText.get(head)} ${p.text}`.trim());
          flowText.set(p, '');
        } else {
          head = p;
          flowText.set(p, p.text);
        }
      }
    }
    const prepared = await Promise.all(
      chains.map(async (chain) => ({
        chain,
        blocks: await Promise.all(
          chain.frames.flatMap((frame, k) =>
            frame.members.map(async (p): Promise<FlowBlock> => {
              const main = await font(fontKey(p.segment));
              const own = textSize(p);
              const cover = p.rect.cover ?? [];
              const s = style.get(!!p.segment.serif);
              return {
                text: flowText.get(p) ?? p.text,
                frame: k,
                x: p.rect.x,
                w: frame.x + frame.w - p.rect.x,
                top: p.rect.y,
                bottom: p.rect.y + p.rect.h,
                size: own * (s?.width ?? 1),
                pitch: measuredPitch(cover) ?? own * (p.segment.kind === 'heading' ? LINE : (s?.pitch ?? LINE)),
                indent: p.firstWord === 0 ? firstIndent(cover) : 0,
                justify: p.segment.kind !== 'heading' && (isJustified(cover) || (!!s?.justified && cover.length > 1)),
                keepWithNext: p.segment.kind === 'heading',
                measure: (t, size) => main.widthOfTextAtSize(t, size),
                hyphenate: p.segment.kind === 'heading' ? (w) => [w] : hyphenate,
              };
            }),
          ),
        ),
      })),
    );
    const bare = graphics.get(number) && paintCovers(graphics.get(number)!, placements, geometry);
    const bpx = bare ? bare.width / geometry.width : 1;
    // Text, který zůstane původní (nepřeložené buňky, čísla), je v obrázku bez textu neviditelný, ale překážkou je.
    const covered = (i: TextItem) =>
      placements.some((p) =>
        (p.rect.cover ?? [[p.rect.x, p.rect.y, p.rect.w, p.rect.h]]).some(([x, y, w, h]) => {
          const cx = i.x + i.w / 2;
          const cy = i.y + i.h / 2;
          return cx >= x - PAD && cx <= x + w + PAD && cy >= y - PAD && cy <= y + h + PAD;
        }),
      );
    const obstacles = (geometry.invisible ? [] : (geometry.items ?? [])).filter((i) => i.str.trim() && !covered(i));
    const free = (members: Placement[]) => (block: number, x: number, y: number, w: number, h: number) => {
      if (obstacles.some((o) => o.x < x + w && o.x + o.w > x && o.y < y + h && o.y + o.h > y)) return false;
      if (!bare) return true;
      const own = members[block].rect;
      // Vlastní původní plocha bloku se nekontroluje (grafika uvnitř bloku k němu patří).
      const parts = [
        [y, Math.min(y + h, own.y)],
        [Math.max(y, own.y + own.h), y + h],
      ].filter(([a, b]) => b - a > 0.5);
      return parts.every(([a, b]) => !hasInk(bare, { x: x * bpx, y: a * bpx, w: w * bpx, h: (b - a) * bpx }, members[block].color));
    };
    const textLeft = Math.min(geometry.width, ...(geometry.items ?? []).map((i) => i.x));
    const textRight = Math.max(0, ...(geometry.items ?? []).map((i) => i.x + i.w));
    // Plocha mimo vlastní blok je volná: bez cizího bloku, nepřeloženého textu a grafiky.
    const clearArea = (box: Box, own: Placement) =>
      box.w > 0.5 &&
      !placements.some((o) => o !== own && o.rect.x < box.x + box.w && o.rect.x + o.rect.w > box.x && o.rect.y < box.y + box.h && o.rect.y + o.rect.h > box.y) &&
      !obstacles.some((o) => o.x < box.x + box.w && o.x + o.w > box.x && o.y < box.y + box.h && o.y + o.h > box.y) &&
      (!bare || !hasInk(bare, { x: box.x * bpx, y: box.y * bpx, w: box.w * bpx, h: box.h * bpx }, own.color));
    // Samostatný blok (popisek přes šířku stránky), který přetéká, se smí rozšířit doprava do volného místa
    // až k pravému okraji textu stránky: bez textu, grafiky a jiných bloků (vzor BabelDOC).
    const widen = (chain: ChainFrame[], blocks: FlowBlock[], check: Free) => {
      const [frame] = chain;
      if (chain.length !== 1 || frame.members.length !== 1) return false;
      const p = frame.members[0];
      const box = { x: frame.x + frame.w + COLUMN_GAP / 2, y: p.rect.y, w: textRight - frame.x - frame.w - COLUMN_GAP / 2, h: p.rect.h };
      if (box.w < 4 || !clearArea(box, p) || !check(0, box.x, box.y, box.w, box.h)) return false;
      frame.w = textRight - frame.x;
      blocks[0].w = frame.x + frame.w - p.rect.x;
      return true;
    };
    // Pro každý řetěz první pokus, při kterém se vejde (jinak poslední).
    const fitted = prepared.map(({ chain, blocks }) => {
      const check = free(chain.frames.flatMap((f) => f.members));
      const attempt = () => {
        for (const [i, options] of ATTEMPTS.entries()) {
          const result = flow(blocks, chain.frames, options, check);
          if (!result.overflow || i === ATTEMPTS.length - 1) return { attempt: i, result };
        }
        throw new Error('unreachable');
      };
      const first = attempt();
      return first.result.overflow && widen(chain.frames, blocks, check) ? attempt() : first;
    });
    // Odstavcový text celé stránky (všechny sloupce) dostane stejné zmenšení; krátké bloky zvlášť.
    const body = (c: number) => prepared[c].chain.frames.some((f) => f.members.some((p) => p.segment.kind === 'paragraph' && rows(p.rect.cover) >= 3));
    const pageAttempt = Math.max(-1, ...fitted.filter((_, c) => body(c)).map((f) => Math.min(f.attempt, PAGE_ATTEMPTS - 1)));
    const results = fitted.map(({ attempt, result }, c) =>
      body(c) && attempt < pageAttempt
        ? flow(prepared[c].blocks, prepared[c].chain.frames, ATTEMPTS[pageAttempt], free(prepared[c].chain.frames.flatMap((f) => f.members)))
        : result,
    );
    for (const [c, { lines }] of results.entries()) {
      const members = prepared[c].chain.frames.flatMap((f) => f.members);
      for (const line of lines) {
        const p = members[line.block];
        const main = await font(fontKey(p.segment));
        const color = luminance(p.color) < 0.5 ? rgb(1, 1, 1) : p.ink && luminance(p.ink) < 0.6 ? rgb(...p.ink) : rgb(0, 0, 0);
        drawFlowLine(page, geometry, line, p, main, color, styles, pieces, number);
        if (line.overflow) overflow.set(p.segment, [...new Set([...(overflow.get(p.segment) ?? []), number])]);
      }
    }
    for (const placement of placements) {
      if (!placement.text || flowed.has(placement)) continue;
      const { segment, rect, color: background, right, room, text, firstWord, marks } = placement;
      const color = luminance(background) < 0.5 ? rgb(1, 1, 1) : rgb(0, 0, 0);
      const regular = await font(segment.serif ? 'serif' : 'sans');
      const bold = await font(segment.serif ? 'serifBold' : 'sansBold');
      const main = segment.bold || segment.kind === 'heading' ? bold : regular;
      const top = geometry.view[3] - rect.y;
      const own = segment.fontSize ?? bodySize ?? 10;
      const size = segment.kind === 'paragraph' && bodySize ? Math.min(Math.max(own, bodySize * 0.9), bodySize * 1.1) : own;
      // Jednořádkový nadpis smí do volného místa ve sloupci, než by se zmenšoval.
      const single = rect.h < size * 2.2 && !segment.centered;
      // Volné místo pod odstavcem se využije dřív, než se písmo zmenší; mezera k dalšímu bloku zůstane.
      const extra = Math.max(0, room - size * 0.8);
      const measure: Measure = (t, s) => main.widthOfTextAtSize(t, s);
      let fitted = fitText(text, { w: rect.w, h: rect.h + extra }, size, measure, single ? right - rect.x : undefined);
      let area = { x: rect.x, w: rect.w };
      if (!fitted.fits) {
        // Nevejde se: do volného místa po stranách až k okrajům textu stránky (na střed na obě strany).
        const left = segment.centered ? Math.min(rect.x, textLeft) : rect.x;
        const sides = [
          { x: left, y: rect.y, w: rect.x - left - PAD, h: rect.h },
          { x: rect.x + rect.w + PAD, y: rect.y, w: textRight - rect.x - rect.w - PAD, h: rect.h },
        ];
        const wide = { x: left, w: textRight - left };
        if (wide.w > rect.w + 4 && sides.every((b) => b.w <= 0.5 || clearArea(b, placement))) {
          const wider = fitText(text, { w: wide.w, h: rect.h + extra }, size, measure);
          if (wider.fits) [fitted, area] = [wider, wide];
        }
      }
      const x = geometry.view[0] + area.x;
      let word = firstWord;
      fitted.lines.forEach((line, l) => {
        const indent = segment.centered ? Math.max(0, (area.w - main.widthOfTextAtSize(line, fitted.size)) / 2) : 0;
        const words = line.split(' ');
        const lineMarks = marks.slice(word, word + words.length);
        word += words.length;
        const y = top - fitted.size * (0.85 + l * LINE);
        if (!lineMarks.some((m) => m.some((v) => v !== undefined))) {
          main.draw(page, line, { x: x + indent, y, size: fitted.size, color });
          return;
        }
        // Řádek s odkazem se kreslí po úsecích, odkaz ve své barvě a případně podtržený.
        let cx = x + indent;
        for (const run of lineRuns(words, lineMarks)) {
          const width = main.widthOfTextAtSize(run.text, fitted.size);
          const link = run.link === undefined ? undefined : segment.links![run.link];
          const style = link && styles.get(link);
          const ink = style?.color ? rgb(...style.color) : color;
          main.draw(page, run.text, { x: cx, y, size: fitted.size, color: ink });
          if (link) {
            if (style?.underline) {
              const uy = y - fitted.size * 0.12;
              page.drawLine({ start: { x: cx, y: uy }, end: { x: cx + width, y: uy }, thickness: Math.max(0.5, fitted.size * 0.06), color: ink });
            }
            if (!pieces.has(link)) pieces.set(link, []);
            pieces.get(link)!.push({ page: number, x: cx, y: y - fitted.size * 0.25, width, height: fitted.size * 1.15 });
          }
          cx += width;
        }
      });
      if (!fitted.fits) overflow.set(segment, [...new Set([...(overflow.get(segment) ?? []), number])]);
    }
  }
  moveLinks(doc, pages, byPage, pieces);
  return { pdf: await doc.save(), overflow, rotated: [...rotated].sort((a, b) => a - b) };
}

type Piece = { page: number; x: number; y: number; width: number; height: number };

/**
 * Části bloku těsně pod sebou ve stejném sloupci (popisek spojený s pokračováním na dalším řádku)
 * se sázejí jako jeden obdélník, jinak by první část při rozšíření dolů překryla druhou.
 */
export function stackRects(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    const gap = last ? r.y - (last.y + last.h) : Infinity;
    if (last && last.page === r.page && gap > -1 && gap < Math.min(last.h, r.h) * 0.8 && overlapX(last, r) > Math.min(last.w, r.w) * 0.5) {
      const x = Math.min(last.x, r.x);
      out[out.length - 1] = {
        ...last,
        x,
        w: Math.max(last.x + last.w, r.x + r.w) - x,
        h: r.y + r.h - last.y,
        chars: (last.chars ?? 0) + (r.chars ?? 0) || undefined,
        cover: last.cover || r.cover ? [...(last.cover ?? [[last.x, last.y, last.w, last.h]]), ...(r.cover ?? [[r.x, r.y, r.w, r.h]])] : undefined,
      };
    } else out.push(r);
  }
  return out;
}

const sameText = (a: string, b: string) => clean(a).replace(/\s+/g, '') === clean(b).replace(/\s+/g, '');

const fontKey = (s: Segment): keyof typeof FONT_FILES =>
  s.bold || s.kind === 'heading' ? (s.serif ? 'serifBold' : 'sansBold') : s.serif ? 'serif' : 'sans';

export interface ChainFrame extends Frame {
  members: Placement[];
}

// Mezera mezi koncem rámu a dalším obsahem pod ním.
const FRAME_GAP = 4;
// Nejmenší mezera mezi sloupci.
const COLUMN_GAP = 6;

const overlapX = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const rows = (cover: Rect['cover']) => new Set((cover ?? []).map(([, y]) => Math.round(y))).size;

/**
 * Rámy stránky: sloupce bloků s plochami řádků, rozdělené tam, kde mezi bloky leží jiný obsah.
 * Rámy podobné šířky za sebou (v pořadí čtení) tvoří řetěz, kterým text přetéká.
 * Samostatný krátký blok (záhlaví, popisek) se sází po staru do svého místa.
 */
export function pageChains(placements: Placement[]): ChainFrame[][] {
  const candidates = placements.filter((p) => p.text && p.segment.kind !== 'table' && !p.segment.figure && p.rect.cover?.length && !p.segment.centered);
  const columns: Placement[][] = [];
  for (const p of candidates) {
    const column = columns.find((c) => Math.abs(c[0].rect.x - p.rect.x) < 6);
    if (column) column.push(p);
    else columns.push([p]);
  }
  // Blok širší než sloupec (záhlaví přes celou stránku) do sloupce nepatří.
  for (const column of [...columns]) {
    const full = column.filter((p) => rows(p.rect.cover) >= 3);
    const width = median((full.length ? full : column).map((p) => p.rect.w))!;
    const wide = column.filter((p) => p.rect.w > width * 1.15);
    if (!wide.length || wide.length === column.length) continue;
    columns.splice(columns.indexOf(column), 1, column.filter((p) => !wide.includes(p)), ...wide.map((p) => [p]));
  }
  const pageBottom = Math.max(...placements.map((p) => p.rect.y + p.rect.h));
  const frames: ChainFrame[] = [];
  for (const column of columns) {
    const full = column.filter((p) => rows(p.rect.cover) >= 3);
    // Pravý okraj sloupce podle typického odstavce; jeden chybně změřený blok sloupec nerozšíří.
    const width = median((full.length ? full : column).map((p) => p.rect.x + p.rect.w))! - Math.min(...column.map((p) => p.rect.x));
    const sorted = [...column].sort((a, b) => a.rect.y - b.rect.y);
    let members: Placement[] = [];
    const close = () => {
      if (!members.length) return;
      const last = members[members.length - 1];
      const bottom = last.rect.y + last.rect.h;
      const room = bottom >= pageBottom - 1 ? Math.min(last.below, MAX_ROOM) : Math.min(last.below, pageBottom - bottom);
      const x = Math.min(...members.map((p) => p.rect.x));
      const top = members[0].rect.y;
      const end = bottom + Math.max(0, room - FRAME_GAP);
      // Rám nesmí zasáhnout do sousedního sloupce ani bloku vpravo vedle sebe.
      const neighbours = placements.filter((o) => !members.includes(o) && o.rect.x > x + COLUMN_GAP && o.rect.y < end && o.rect.y + o.rect.h > top);
      const limit = Math.min(...neighbours.map((o) => o.rect.x - COLUMN_GAP));
      frames.push({ x, w: Math.max(1, Math.min(width, limit - x)), top, bottom: end, members });
      members = [];
    };
    sorted.forEach((p, i) => {
      const prev = sorted[i - 1];
      if (prev) {
        const end = prev.rect.y + prev.rect.h;
        // Mezi bloky je jiný obsah: obrázek, čára, nebo blok, který do sloupce nepatří.
        const blocked =
          prev.anchored || p.anchored || prev.below + 3 < p.rect.y - end || placements.some((o) => !column.includes(o) && o.rect.y < p.rect.y && o.rect.y + o.rect.h > end && overlapX(o.rect, p.rect) > 0);
        if (blocked) close();
      }
      members.push(p);
    });
    close();
  }
  const order = (f: ChainFrame) => placements.indexOf(f.members[0]);
  frames.sort((a, b) => order(a) - order(b));
  const chains: ChainFrame[][] = [];
  for (const frame of frames) {
    const chain = chains[chains.length - 1];
    const prev = chain?.[chain.length - 1];
    if (prev && frame.w / prev.w > 0.8 && frame.w / prev.w < 1.25) chain.push(frame);
    else chains.push([frame]);
  }
  return chains.filter((c) => c.length > 1 || c[0].members.length > 1 || rows(c[0].members[0].rect.cover) > 2);
}

interface TextStyle {
  /** Šířka písma originálu vůči Noto (násobek velikosti, aby text zabral stejně místa). */
  width: number;
  /** Rozestup řádků jako násobek velikosti písma. */
  pitch?: number;
  justified: boolean;
}

/** Vlastnosti sazby originálu zvlášť pro patkové a bezpatkové písmo, z celých odstavců o aspoň třech řádcích. */
async function documentStyle(placements: Placement[], fontFor: (serif: boolean) => Promise<TextFont>): Promise<Map<boolean, TextStyle>> {
  const samples = new Map<boolean, { width: number[]; pitch: number[]; justified: number }>();
  for (const p of placements) {
    const cover = p.rect.cover;
    const whole = p.segment.rects?.length === 1 && p.segment.rects[0].cover?.length === cover?.length;
    if (p.segment.kind !== 'paragraph' || !cover || !whole || !p.segment.fontSize || rows(cover) < 3) continue;
    const serif = !!p.segment.serif;
    const font = await fontFor(serif);
    const natural = font.widthOfTextAtSize(clean(p.segment.source).replace(/\s+/g, ' '), p.segment.fontSize);
    const sample = samples.get(serif) ?? { width: [], pitch: [], justified: 0 };
    sample.width.push(sum(cover.map(([, , w]) => w)) / natural);
    const pitch = measuredPitch(cover);
    if (pitch) sample.pitch.push(pitch / p.segment.fontSize);
    if (isJustified(cover)) sample.justified++;
    samples.set(serif, sample);
  }
  const style = new Map<boolean, TextStyle>();
  for (const [serif, s] of samples) {
    style.set(serif, {
      width: Math.min(1.05, Math.max(0.9, median(s.width)!)),
      pitch: median(s.pitch),
      justified: s.justified > s.width.length / 2,
    });
  }
  return style;
}

/** Řádek vysázený po úsecích; odkazy ve své barvě, případně podtržené, s novou klikací plochou. */
function drawFlowLine(
  page: PDFPage,
  geometry: PageGeometry,
  line: PlacedLine,
  p: Placement,
  font: TextFont,
  color: ReturnType<typeof rgb>,
  styles: Map<SegmentLink, LinkStyle>,
  pieces: Map<SegmentLink, Piece[]>,
  number: number,
) {
  const y = geometry.view[3] - line.y - line.size * 0.85;
  let cx = geometry.view[0] + line.x;
  for (const token of line.tokens) {
    const marks = p.marks[p.firstWord + token.word] ?? [];
    // Přidaný spojovník patří ke stejnému odkazu jako písmeno před ním.
    const mark = (c: number) => marks[token.from + c] ?? marks[token.from + c - 1];
    const runs: { text: string; link?: number }[] = [];
    for (let c = 0; c < token.text.length; c++) {
      const last = runs[runs.length - 1];
      if (last && last.link === mark(c)) last.text += token.text[c];
      else runs.push({ text: token.text[c], link: mark(c) });
    }
    for (const run of runs) {
      const width = font.widthOfTextAtSize(run.text, line.size);
      const link = run.link === undefined ? undefined : p.segment.links?.[run.link];
      const style = link && styles.get(link);
      const ink = style?.color ? rgb(...style.color) : color;
      font.draw(page, run.text, { x: cx, y, size: line.size, color: ink });
      if (link) {
        const list = pieces.get(link) ?? [];
        const prev = list[list.length - 1];
        const joined = prev && prev.page === number && Math.abs(prev.y - (y - line.size * 0.25)) < 0.1 && cx - (prev.x + prev.width) <= line.space + 0.5;
        const start = joined ? prev.x + prev.width : cx;
        if (style?.underline) {
          const uy = y - line.size * 0.12;
          page.drawLine({ start: { x: start, y: uy }, end: { x: cx + width, y: uy }, thickness: Math.max(0.5, line.size * 0.06), color: ink });
        }
        if (joined) prev.width = cx + width - prev.x;
        else list.push({ page: number, x: cx, y: y - line.size * 0.25, width, height: line.size * 1.15 });
        pieces.set(link, list);
      }
      cx += width;
    }
    cx += line.space;
  }
}

/**
 * Klikací plochy odkazů na nové místo: původní anotace odkazu se nahradí kopií na každém řádku překladu.
 * Odkaz, který se v překladu nenašel, a cizí odkaz nad přemalovaným textem se odstraní (kliknutí by trefilo jiné slovo).
 */
function moveLinks(doc: PDFDocument, pages: Map<number, PageGeometry>, byPage: Map<number, Placement[]>, pieces: Map<SegmentLink, Piece[]>) {
  const templates = new Map<SegmentLink, PDFDict>();
  for (const [number, placements] of byPage) {
    const { view } = pages.get(number)!;
    const annots = doc.getPage(number - 1).node.Annots();
    if (!annots) continue;
    const placed = placements.flatMap((p) => p.segment.links ?? []);
    const covered = placements.flatMap((p) => (p.rect.cover ?? [[p.rect.x, p.rect.y, p.rect.w, p.rect.h]]).map(([x, y, w, h]) => toPdfRect({ x, y, w, h }, view)));
    for (let k = annots.size() - 1; k >= 0; k--) {
      const annot = annots.lookup(k);
      if (!(annot instanceof PDFDict) || annot.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
      const rect = annot.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asRectangle();
      if (!rect) continue;
      const near = (o: Rect) => {
        const r = toPdfRect(o, view);
        return Math.abs(r.x - rect.x) < 1 && Math.abs(r.y - rect.y) < 1 && Math.abs(r.width - rect.width) < 1 && Math.abs(r.height - rect.height) < 1;
      };
      const owner = placed.find((l) => l.rects.some((o) => o.page === number && near(o)));
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (owner) {
        if (!templates.has(owner)) templates.set(owner, annot);
        annots.remove(k);
      } else if (covered.some((c) => cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height)) annots.remove(k);
    }
  }
  for (const [link, list] of pieces) {
    const template = templates.get(link);
    if (!template) continue;
    for (const piece of list) {
      const page = doc.getPage(piece.page - 1);
      const copy = template.clone(doc.context);
      copy.set(PDFName.of('Rect'), doc.context.obj([piece.x, piece.y, piece.x + piece.width, piece.y + piece.height]));
      copy.delete(PDFName.of('QuadPoints'));
      copy.set(PDFName.of('P'), page.ref);
      page.node.addAnnot(doc.context.register(copy));
    }
  }
}
