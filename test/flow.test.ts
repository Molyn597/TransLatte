import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ATTEMPTS,
  Breaker,
  firstIndent,
  flow,
  isJustified,
  linePitch,
  measuredPitch,
  type Frame,
  type FlowBlock,
  type Hyphenate,
  type Measure,
} from '../src/main/flow';
import { hyphenParts } from '../src/main/hyphenate';

const FONTS = path.join(__dirname, '..', 'build', 'fonts');
let measure: Measure;
let hyphenate: Hyphenate;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await readFile(path.join(FONTS, 'NotoSans-Regular.ttf')), { subset: true });
  measure = (text, size) => font.widthOfTextAtSize(text, size);
  hyphenate = (word) => hyphenParts(word, 'cs');
});

const LONG = 'Překlad bývá delší než originál a musí se vejít do stejného místa na stránce a ještě o něco víc.';

function block(text: string, over: Partial<FlowBlock> = {}): FlowBlock {
  return {
    text,
    frame: 0,
    x: 50,
    w: 200,
    top: 100,
    bottom: 1000,
    size: 10,
    pitch: 14,
    indent: 0,
    justify: false,
    keepWithNext: false,
    measure,
    hyphenate,
    ...over,
  };
}

const ONE: Frame[] = [{ x: 50, w: 200, top: 100, bottom: 400 }];
const O1 = { scale: 1, leading: 1 };

describe('Breaker', () => {
  it('zalamuje po slovech na zadanou šířku a \\n je pevný konec řádku', () => {
    const width = measure('a b c', 10) + 0.5;
    const b = new Breaker('a b c d\ne f', 10, measure, hyphenate);
    const first = b.next(width);
    expect(first.tokens.map((t) => t.text)).toEqual(['a', 'b', 'c']);
    expect(first.last).toBe(false);
    const second = b.next(width);
    expect(second.tokens.map((t) => t.text)).toEqual(['d']);
    expect(second.last).toBe(true);
    const third = b.next(1000);
    expect(third.tokens.map((t) => t.text)).toEqual(['e', 'f']);
    expect(third.last).toBe(true);
    expect(b.done).toBe(true);
  });

  it('řádek před pevným koncem a poslední řádek odstavce mají last true, ostatní false', () => {
    const b = new Breaker('a b c d e f g h\ni j', 10, measure, hyphenate);
    const lines = [];
    while (!b.done) lines.push(b.next(measure('a b c', 10) + 0.5));
    // Řádek s posledním slovem prvního odstavce a poslední řádek odstavce druhého.
    const beforeBreak = lines.findIndex((l) => l.tokens.some((t) => t.text === 'h'));
    expect(lines[beforeBreak].last).toBe(true);
    expect(lines[beforeBreak - 1].last).toBe(false);
    expect(lines[lines.length - 1].tokens.map((t) => t.text)).toEqual(['i', 'j']);
    expect(lines[lines.length - 1].last).toBe(true);
    expect(lines.filter((l) => l.last)).toHaveLength(2);
  });

  it('slovo, které se nevejde, rozdělí podle hyphenate a připojí spojovník', () => {
    const word = 'nejnepravdepodobnejsimi';
    const parts = hyphenate(word);
    expect(parts.length).toBeGreaterThan(1);
    const width = measure(`ab ${parts[0]}-`, 10) + 0.5;
    const b = new Breaker(`ab ${word}`, 10, measure, hyphenate);
    const first = b.next(width);
    const head = first.tokens[first.tokens.length - 1];
    expect(head.text.endsWith('-')).toBe(true);
    expect(head.word).toBe(1);
    expect(head.from).toBe(0);
    const second = b.next(1000);
    expect(second.tokens[0].word).toBe(1);
    expect(second.tokens[0].from).toBeGreaterThan(0);
    expect(second.tokens[0].from).toBe(head.text.length - 1);
    expect(head.text.slice(0, -1) + second.tokens[0].text).toBe(word);
  });

  it('část už končící spojovníkem nedostane druhý spojovník', () => {
    const word = 'Check-nejnepravdepodobnejsimi';
    const b = new Breaker(word, 10, measure, hyphenate);
    const first = b.next(measure('Check-', 10) + 0.5);
    expect(first.tokens.map((t) => t.text)).toEqual(['Check-']);
    expect(first.tokens[0].from).toBe(0);
    const second = b.next(1000);
    expect(second.tokens[0].text.startsWith('-')).toBe(false);
    expect(second.tokens[0].from).toBe(6);
  });

  it('nedělitelné slovo delší než řádek zůstane celé na samostatném řádku', () => {
    const b = new Breaker('ABC12345678901234 x', 10, measure, hyphenate);
    const first = b.next(40);
    expect(first.tokens).toEqual([{ text: 'ABC12345678901234', word: 0, from: 0 }]);
    const second = b.next(40);
    expect(second.tokens.map((t) => t.text)).toEqual(['x']);
    expect(b.done).toBe(true);
  });

  it('šířku lze měnit řádek od řádku', () => {
    const b = new Breaker('jedna dva tři čtyři pět šest sedm osm devět deset', 10, measure, hyphenate);
    const wide = b.next(measure('jedna dva tři čtyři', 10) + 0.5);
    const narrow = b.next(measure('jedna', 10) + 0.5);
    expect(narrow.tokens.length).toBeLessThan(wide.tokens.length);
    expect(narrow.tokens.length).toBe(1);
  });
});

describe('flow', () => {
  it('text, který se vejde do prvního rámu, zůstane v něm', () => {
    const b = block('Krátký odstavec, který se vejde do jednoho rámu bez přetečení.');
    const { lines, overflow } = flow([b], ONE, O1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.x === 50)).toBe(true);
    expect(lines[0].y).toBe(100);
    expect(overflow).toBe(false);
    expect(lines.some((l) => l.overflow)).toBe(false);
  });

  it('řádky jdou po linePitch a první je na top bloku', () => {
    const b = block(LONG, { top: 120 });
    const { lines } = flow([b], [{ x: 50, w: 200, top: 120, bottom: 400 }], O1);
    const pitch = linePitch(b, O1);
    expect(lines[0].y).toBe(120);
    lines.slice(1).forEach((l, i) => expect(l.y - lines[i].y).toBeCloseTo(pitch));
  });

  it('delší text přeteče do druhého rámu bez přetečení', () => {
    const frames: Frame[] = [
      { x: 50, w: 200, top: 100, bottom: 130 },
      { x: 300, w: 200, top: 100, bottom: 400 },
    ];
    const { lines, overflow } = flow([block(`${LONG} ${LONG} ${LONG}`)], frames, O1);
    const second = lines.filter((l) => l.x === 300);
    expect(second.length).toBeGreaterThan(0);
    expect(second[0].y).toBe(100);
    expect(lines.some((l) => l.overflow)).toBe(false);
    expect(overflow).toBe(false);
  });

  it('bez druhého rámu přetečené řádky označí overflow a výsledek je overflow true', () => {
    const frames: Frame[] = [{ x: 50, w: 200, top: 100, bottom: 130 }];
    const { lines, overflow } = flow([block(`${LONG} ${LONG} ${LONG}`)], frames, O1);
    expect(overflow).toBe(true);
    expect(lines[lines.length - 1].overflow).toBe(true);
    expect(lines[0].overflow).toBe(false);
  });

  it('druhý blok téhož rámu začne pod prvním s původní mezerou', () => {
    const a = block('První odstavec.', { top: 100, bottom: 112 });
    const b = block('Druhý odstavec.', { top: 150, bottom: 200 });
    const { lines } = flow([a, b], [{ x: 50, w: 200, top: 100, bottom: 400 }], O1);
    const aLast = lines.filter((l) => l.block === 0).at(-1)!;
    const bFirst = lines.find((l) => l.block === 1)!;
    expect(bFirst.y - (aLast.y + 1.2 * 10)).toBeCloseTo(b.top - a.bottom);
  });

  it('nadpis s keepWithNext na konci rámu se přesune do dalšího rámu', () => {
    const frames: Frame[] = [
      { x: 50, w: 200, top: 100, bottom: 150 },
      { x: 300, w: 200, top: 100, bottom: 400 },
    ];
    const para = block('Odstavec.', { top: 100, bottom: 112 });
    const heading = (keep: boolean) => block('Nadpis', { top: 112, bottom: 124, keepWithNext: keep });
    const next = block(LONG, { top: 134, bottom: 400 });
    const kept = flow([para, heading(true), next], frames, O1).lines.find((l) => l.block === 1)!;
    expect(kept.x).toBe(300);
    const free = flow([para, heading(false), next], frames, O1).lines.find((l) => l.block === 1)!;
    expect(free.x).toBe(50);
  });

  it('zarovnání do bloku: řádky kromě posledního vyplní šířku, poslední má běžnou mezeru', () => {
    const b = block(`${LONG} ${LONG}`, { justify: true });
    const { lines } = flow([b], ONE, O1);
    const plain = measure(' ', 10);
    expect(lines.length).toBeGreaterThan(2);
    lines.slice(0, -1).forEach((l) => {
      const gaps = l.tokens.length - 1;
      expect(gaps).toBeGreaterThan(0);
      expect(l.space).toBeGreaterThan(plain);
      const glyphs = measure(l.tokens.map((t) => t.text).join(''), 10);
      expect(Math.abs(glyphs + gaps * l.space - 200)).toBeLessThan(0.5);
    });
    expect(lines[lines.length - 1].space).toBeCloseTo(plain);
  });

  it('bez justify je mezera vždy běžná', () => {
    const b = block(`${LONG} ${LONG}`);
    const { lines } = flow([b], ONE, O1);
    const plain = measure(' ', 10);
    lines.forEach((l) => expect(l.space).toBeCloseTo(plain));
  });

  it('při menším měřítku se vejde text, který při měřítku 1 přeteče', () => {
    const frames: Frame[] = [{ x: 50, w: 200, top: 0, bottom: 65 }];
    const b = block(`${LONG} ${LONG}`, { top: 0 });
    expect(flow([b], frames, { scale: 1, leading: 1 }).overflow).toBe(true);
    expect(flow([b], frames, { scale: 0.85, leading: 0.92 }).overflow).toBe(false);
    expect(ATTEMPTS.find((o) => !flow([b], frames, o).overflow)).toBeDefined();
  });
});

describe('zjištění z ploch řádků', () => {
  it('measuredPitch vrátí medián rozdílů horních okrajů', () => {
    const cover: [number, number, number, number][] = [
      [50, 100, 150, 10],
      [50, 114, 150, 10],
      [50, 128, 150, 10],
      [50, 145, 150, 10],
    ];
    expect(measuredPitch(cover)).toBe(14);
    expect(measuredPitch([[50, 100, 150, 10]])).toBeUndefined();
  });

  it('isJustified je true jen při ≥4 řádcích se stejným pravým okrajem', () => {
    const justified: [number, number, number, number][] = [
      [50, 100, 200, 10],
      [50, 114, 200, 10],
      [50, 128, 200, 10],
      [50, 142, 150, 10],
    ];
    expect(isJustified(justified)).toBe(true);
    const ragged: [number, number, number, number][] = [
      [50, 100, 200, 10],
      [50, 114, 180, 10],
      [50, 128, 150, 10],
    ];
    expect(isJustified(ragged)).toBe(false);
    expect(isJustified([...justified.slice(0, 2), justified[3]])).toBe(false);
  });

  it('firstIndent vrátí odsazení prvního řádku, bez odsazení 0', () => {
    const indented: [number, number, number, number][] = [
      [70, 100, 180, 10],
      [50, 114, 200, 10],
      [50, 128, 200, 10],
    ];
    expect(firstIndent(indented)).toBe(20);
    const plain: [number, number, number, number][] = [
      [50, 100, 200, 10],
      [50, 114, 200, 10],
    ];
    expect(firstIndent(plain)).toBe(0);
  });
});
