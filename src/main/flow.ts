// Sazba odstavců do sloupců stránky: text teče rámem a přetéká do dalšího rámu na stejné stránce (jako DeepL).
// Souřadnice viewportu pdf.js (body, počátek vlevo nahoře).

export type Measure = (text: string, size: number) => number;
/** Části slova, mezi kterými se smí zalomit (spojené dávají slovo). */
export type Hyphenate = (word: string) => string[];

/** Úsek slova na řádku; `from` je pozice prvního znaku ve slově `word` (kvůli odkazům). */
export interface Token {
  text: string;
  word: number;
  from: number;
}

export interface Line {
  tokens: Token[];
  /** Poslední řádek odstavce nebo před pevným koncem řádku: do bloku se nezarovnává. */
  last: boolean;
}

const SPACE = ' ';
const lineText = (tokens: Token[]) => tokens.map((t) => t.text).join(SPACE);
// Řádek zarovnaný vlevo, zaplněný aspoň z tohoto podílu, se nedělí (dělení by jen přidalo spojovníky).
const RAGGED_FILL = 0.85;
// Nejvýš tolik řádků za sebou smí končit rozděleným slovem.
const MAX_HYPHEN_RUN = 2;

/** Slova textu po řádcích (`\n` = pevný konec řádku), číslovaná napříč celým textem jako ve wordMarks. */
export function words(text: string): string[][] {
  return text.split('\n').map((l) => l.split(/\s+/).filter(Boolean));
}

/**
 * Postupné zalamování: každý řádek může mít jinou šířku (text přeteče do užšího sloupce).
 * Slovo, které se nevejde, se zkusí rozdělit; nedělitelné slovo delší než řádek zůstane celé.
 */
export class Breaker {
  private hard: string[][];
  private row = 0;
  private index = 0;
  /** Zbytek rozděleného slova (od znaku `from`). */
  private from = 0;
  private wordBase: number[] = [];
  /** Kolik řádků za sebou už končí rozděleným slovem. */
  private hyphenRun = 0;

  constructor(
    text: string,
    private size: number,
    private measure: Measure,
    private hyphenate: Hyphenate,
    /** Do bloku: dělí se vždy, když se slovo nevejde; jinak jen když by řádek zůstal krátký. */
    private justify = false,
  ) {
    this.hard = words(text);
    let n = 0;
    for (const row of this.hard) {
      this.wordBase.push(n);
      n += row.length;
    }
    this.skipEmpty();
  }

  get done() {
    return this.row >= this.hard.length;
  }

  private skipEmpty() {
    while (this.row < this.hard.length && this.index >= this.hard[this.row].length) {
      this.row++;
      this.index = 0;
      this.from = 0;
    }
  }

  next(width: number): Line {
    const row = this.hard[this.row];
    const tokens: Token[] = [];
    const fits = (extra: string) => this.measure(tokens.length ? `${lineText(tokens)}${SPACE}${extra}` : extra, this.size) <= width + 0.01;
    while (this.index < row.length) {
      const word = row[this.index];
      const rest = word.slice(this.from);
      const id = this.wordBase[this.row] + this.index;
      if (fits(rest)) {
        tokens.push({ text: rest, word: id, from: this.from });
        this.index++;
        this.from = 0;
        continue;
      }
      // Nejdelší začátek zbytku slova, který se vejde i se spojovníkem.
      const full = this.measure(lineText(tokens), this.size) >= width * RAGGED_FILL;
      const parts = this.hyphenRun >= MAX_HYPHEN_RUN || (!this.justify && full) ? [rest] : this.hyphenate(rest);
      let taken = '';
      for (let k = parts.length - 1; k >= 1; k--) {
        const head = parts.slice(0, k).join('');
        const shown = head.endsWith('-') ? head : `${head}-`;
        if (fits(shown)) {
          tokens.push({ text: shown, word: id, from: this.from });
          taken = head;
          break;
        }
      }
      if (taken) this.from += taken.length;
      else if (!tokens.length) {
        tokens.push({ text: rest, word: id, from: this.from });
        this.index++;
        this.from = 0;
      }
      break;
    }
    const last = this.index >= row.length;
    this.hyphenRun = this.from > 0 ? this.hyphenRun + 1 : 0;
    this.skipEmpty();
    return { tokens, last };
  }
}

/** Rám: obdélník, kterým text teče (sloupec mezi překážkami). */
export interface Frame {
  x: number;
  w: number;
  top: number;
  bottom: number;
}

export interface FlowBlock {
  text: string;
  /** Rám, ve kterém blok leží v originálu (index v řetězu). */
  frame: number;
  /** Levý okraj a šířka bloku v originálu. */
  x: number;
  w: number;
  top: number;
  bottom: number;
  /** Velikost písma při měřítku 1. */
  size: number;
  /** Rozestup řádků v bodech při měřítku 1. */
  pitch: number;
  /** Odsazení prvního řádku. */
  indent: number;
  justify: boolean;
  /** Nadpis: nezůstane sám na konci rámu. */
  keepWithNext: boolean;
  measure: Measure;
  hyphenate: Hyphenate;
}

export interface PlacedLine {
  block: number;
  tokens: Token[];
  x: number;
  /** Horní okraj řádku. */
  y: number;
  size: number;
  /** Mezera mezi úseky (při zarovnání do bloku větší než mezera písma). */
  space: number;
  /** Řádek se nevešel do žádného rámu. */
  overflow: boolean;
}

export interface FlowOptions {
  /** Měřítko písma i řádkování. */
  scale: number;
  /** Hustší řádkování (podíl původního rozestupu). */
  leading: number;
}

// Výška řádku od horního okraje po dotažnice (jako plocha řádku v originálu).
const LINE_BOX = 1.2;
// Řádkování nikdy hustší než tolik násobků písma.
const MIN_PITCH = 1.1;
// Do bloku jen do této mezery mezi slovy (násobek písma), jinak by řádek zel dírami.
const MAX_SPACE = 0.9;
// Mezera mezi odstavci bez odsazení, když původní mezeru nejde změřit (násobek písma).
const PARAGRAPH_GAP = 0.6;
// Krok (body), o který se řádek posouvá pod grafiku.
const FREE_STEP = 1;

export const linePitch = (b: FlowBlock, o: FlowOptions) => Math.max(b.pitch * o.scale * o.leading, b.size * o.scale * MIN_PITCH);

/**
 * Vysází bloky řetězu rámů za sebou. Mezery mezi bloky zůstanou jako v originálu,
 * co se nevejde do rámu, pokračuje nahoře v dalším; za posledním rámem se řádky označí jako přetečené.
 */
/** Je plocha řádku bez cizí grafiky (obrázek, odrážka, čára)? */
export type Free = (block: number, x: number, y: number, w: number, h: number) => boolean;

export function flow(blocks: FlowBlock[], frames: Frame[], o: FlowOptions, free?: Free): { lines: PlacedLine[]; overflow: boolean } {
  const lines: PlacedLine[] = [];
  let f = 0;
  let y = frames[0]?.top ?? 0;
  let overflow = false;
  // Kde v rámu skončil poslední blok v originálu a v novém textu.
  let prevBottom: number | undefined;

  const advance = () => {
    if (f + 1 >= frames.length) return false;
    f++;
    y = frames[f].top;
    prevBottom = undefined;
    return true;
  };

  blocks.forEach((b, i) => {
    const size = b.size * o.scale;
    const pitch = linePitch(b, o);
    const box = size * LINE_BOX;
    // Blok z dalšího sloupce začne nejdřív na svém původním místě v tom sloupci.
    while (b.frame > f && advance()) {
      // Původní mezera od horního okraje rámu.
      y = Math.max(frames[f].top, b.top);
    }
    const prev = i > 0 ? blocks[i - 1] : undefined;
    if (prevBottom !== undefined && prev) {
      // Původní mezera jen mezi bloky téhož rámu; za přetečeným textem z jiného sloupce mezera odstavce.
      const gap = prev.frame === b.frame ? Math.max(0, b.top - prev.bottom) : b.indent > 0 ? 0 : size * PARAGRAPH_GAP;
      y = prevBottom + gap * (prev.frame === b.frame ? o.scale : 1);
    }

    if (b.keepWithNext && blocks[i + 1]) {
      // Nadpis s prvními dvěma řádky dalšího bloku; jinak celý do dalšího rámu.
      const next = blocks[i + 1];
      const own = new Breaker(b.text, size, b.measure, b.hyphenate, b.justify);
      let count = 0;
      while (!own.done) {
        own.next(b.w);
        count++;
      }
      const need = (count - 1) * pitch + box + Math.max(0, next.top - b.bottom) * o.scale + linePitch(next, o) + next.size * o.scale * LINE_BOX;
      if (y + need > frames[f].bottom + 0.5 && y > frames[f].top + 0.5) advance();
    }

    const breaker = new Breaker(b.text, size, b.measure, b.hyphenate, b.justify);
    let first = true;
    while (!breaker.done) {
      let x = 0;
      let width = 1;
      // Řádek přes cizí grafiku se posune níž, případně do dalšího rámu.
      for (;;) {
        const overflowing = y + box > frames[f].bottom + 0.5 && !advance();
        const frame = frames[f];
        // Odsazení bloku vůči sloupci zůstane i v dalším rámu.
        const origin = frames[b.frame] ?? frame;
        const offset = Math.max(0, b.x - origin.x);
        x = frame.x + offset + (first ? b.indent : 0);
        width = Math.max(1, Math.min(b.w, frame.w - offset) - (first ? b.indent : 0));
        if (overflowing) overflow = true;
        // Rám nižší než řádek se přeskočí.
        else if (y + box > frame.bottom + 0.5) continue;
        if (overflowing || !free || free(i, x, y, width, box)) break;
        y += FREE_STEP;
      }
      const frame = frames[f];
      const line = breaker.next(width);
      const natural = b.measure(lineText(line.tokens), size);
      const gaps = line.tokens.length - 1;
      const plain = b.measure(SPACE, size);
      const stretched = gaps > 0 ? plain + (width - natural) / gaps : plain;
      const space = b.justify && !line.last && gaps > 0 && stretched - plain <= size * MAX_SPACE ? stretched : plain;
      lines.push({ block: i, tokens: line.tokens, x, y, size, space, overflow: y + box > frame.bottom + 0.5 });
      y += pitch;
      first = false;
    }
    prevBottom = y - pitch + box;
  });
  return { lines, overflow };
}

/** Kroky zkoušení: nejdřív původní vzhled, pak hustší řádkování, pak menší písmo (nejvýš na 85 %). */
export const ATTEMPTS: FlowOptions[] = [
  { scale: 1, leading: 1 },
  { scale: 1, leading: 0.92 },
  ...[0.97, 0.94, 0.91, 0.88, 0.85].map((scale) => ({ scale, leading: 0.92 })),
];

/** Rozestup řádků podle ploch řádků v originálu (medián rozdílu horních okrajů); bez víc řádků undefined. */
export function measuredPitch(cover: [number, number, number, number][]): number | undefined {
  const ys = [...new Set(cover.map(([, y]) => y))].sort((a, b) => a - b).filter((y, i, all) => !i || y - all[i - 1] > 1);
  const diffs = ys.slice(1).map((y, i) => y - ys[i]);
  if (!diffs.length) return undefined;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor((diffs.length - 1) / 2)];
}

/** Zarovnání do bloku: všechny řádky kromě posledního končí u pravého okraje bloku. */
export function isJustified(cover: [number, number, number, number][]): boolean {
  const rows = new Map<number, number>();
  for (const [x, y, w] of cover) rows.set(Math.round(y), Math.max(rows.get(Math.round(y)) ?? 0, x + w));
  const rights = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  // Ze tří řádků se zarovnání do bloku nedá poznat (dva řádky mohou skončit stejně náhodou).
  if (rights.length < 4) return false;
  const max = Math.max(...rights);
  return rights.slice(0, -1).every((r) => max - r < 2);
}

/** Odsazení prvního řádku vůči ostatním (0, když není nebo je předsazený). */
export function firstIndent(cover: [number, number, number, number][]): number {
  const rows = new Map<number, number>();
  for (const [x, y] of cover) rows.set(Math.round(y), Math.min(rows.get(Math.round(y)) ?? Infinity, x));
  const lefts = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  if (lefts.length < 2) return 0;
  const rest = Math.min(...lefts.slice(1));
  return Math.max(0, lefts[0] - rest);
}
