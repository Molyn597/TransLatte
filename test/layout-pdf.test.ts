import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  backgroundColor,
  blankBelow,
  buildLayoutPdf,
  fitTable,
  fitText,
  inkDifference,
  visiblePart,
  splitText,
  tableRows,
  textHeight,
  toPdfRect,
  wrapText,
  type Measure,
  type PageGeometry,
} from '../src/main/layout-pdf';
import type { Segment } from '../src/shared/types';

const FONTS = path.join(__dirname, '..', 'build', 'fonts');
let measure: Measure;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await readFile(path.join(FONTS, 'NotoSans-Regular.ttf')), { subset: true });
  measure = (text, size) => font.widthOfTextAtSize(text, size);
});

describe('souřadnice', () => {
  it('převede obdélník viewportu do PDF i s posunutým cropBox', () => {
    const view: PageGeometry['view'] = [20, 30, 620, 830];
    expect(toPdfRect({ x: 50, y: 100, w: 200, h: 40 }, view)).toEqual({ x: 70, y: 690, width: 200, height: 40 });
    expect(toPdfRect({ x: 0, y: 0, w: 600, h: 800 }, view)).toEqual({ x: 20, y: 30, width: 600, height: 800 });
  });
});

describe('rozdělení textu mezi obdélníky', () => {
  it('dělí v poměru délky zdroje na hranici slova', () => {
    const text = 'jedna dva tři čtyři pět šest sedm osm devět deset';
    const [a, b] = splitText(text, [30, 70]);
    expect(`${a} ${b}`).toBe(text);
    expect(a).toBe('jedna dva tři');
    expect(splitText(text, [1])).toEqual([text]);
  });

  it('bez vah dělí rovným dílem a slovo nepůlí', () => {
    const parts = splitText('aaaa bbbb cccc dddd', [0, 0]);
    expect(parts).toEqual(['aaaa bbbb', 'cccc dddd']);
  });
});

describe('sazba', () => {
  it('zalamuje po slovech na šířku a drží pevné konce řádků', () => {
    const lines = wrapText('Příliš žluťoučký kůň úpěl ďábelské ódy\n- druhá položka', 100, 10, measure);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => measure(l, 10) <= 100 || !l.includes(' '))).toBe(true);
    expect(lines[lines.length - 1]).toBe('- druhá položka');
  });

  it('vejde-li se text, zůstane původní velikost', () => {
    const fitted = fitText('Krátký text', { w: 200, h: 14 }, 10, measure);
    expect(fitted).toMatchObject({ size: 10, fits: true, lines: ['Krátký text'] });
  });

  it('zmenšuje po 5 % a nejvýš na 70 %, pak přeteče', () => {
    const text = 'Překlad bývá delší než originál a musí se vejít do stejného místa na stránce.';
    const box = { w: 150, h: textHeight(3, 10) };
    const smaller = fitText(text, box, 12, measure);
    expect(smaller.fits).toBe(true);
    expect(smaller.size).toBeLessThan(12);
    expect(smaller.size).toBeGreaterThanOrEqual(12 * 0.7 - 1e-9);
    expect(Math.round((smaller.size / 12) * 100) % 5).toBe(0);
    const tight = fitText(text.repeat(4), { w: 150, h: 20 }, 12, measure);
    expect(tight.fits).toBe(false);
    expect(tight.size).toBeCloseTo(12 * 0.7);
    // Přesah: všechen text je v řádcích, nic se neořízne.
    const words = (t: string) => t.split(/\s+/).filter(Boolean);
    expect(words(tight.lines.join(' '))).toEqual(words(text.repeat(4)));
  });

  it('jednořádkový text zkusí širší místo dřív, než zmenší písmo', () => {
    const text = '1. Neustálé informování zaměstnanců';
    const narrow = fitText(text, { w: 80, h: 13 }, 10, measure);
    expect(narrow.size).toBeLessThan(10);
    const wide = fitText(text, { w: 80, h: 13 }, 10, measure, 400);
    expect(wide).toMatchObject({ size: 10, fits: true, lines: [text] });
  });

  it('tabulku rozloží do sloupců podle počtu buněk', () => {
    const rows = tableRows('| Skupina | Průměrný spánek |\n| --- | --- |\n| Krátce spící | 5,8 h |');
    expect(rows).toEqual([['Skupina', 'Průměrný spánek'], ['Krátce spící', '5,8 h']]);
    const table = fitTable(rows, { w: 200, h: 30 }, 10, measure);
    expect(table.widths).toHaveLength(2);
    expect(table.widths.reduce((n, w) => n + w, 0)).toBeCloseTo(200);
    expect(table.fits).toBe(true);
  });
});

describe('barva pozadí', () => {
  it('vezme medián pixelů na obvodu obdélníku', () => {
    const width = 10;
    const height = 10;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([20, 40, 200, 255], i * 4);
    // Jeden černý pixel na okraji medián nezmění.
    data.set([0, 0, 0, 255], (2 * width + 2) * 4);
    const [r, g, b] = backgroundColor({ width, height, data }, { x: 2, y: 2, w: 5, h: 5 });
    expect([r, g, b].map((v) => Math.round(v * 255))).toEqual([20, 40, 200]);
  });
});

describe('viditelnost textu', () => {
  const white = { width: 600, height: 800, data: new Uint8Array(600 * 800 * 4).fill(255) };
  // S textem: od y = 200 každý třetí pixel tmavý; nahoře je text schovaný (stejné jako bez textu).
  const half = { ...white, data: white.data.map((v, i) => (i >= 600 * 4 * 200 && Math.floor(i / 4) % 3 === 0 && i % 4 < 3 ? 0 : v)) };
  const geometry: PageGeometry = { view: [0, 0, 600, 800], rotate: 0, width: 600, height: 800 };

  it('porovná vykreslení s textem a bez něj', () => {
    expect(inkDifference(half, white, { x: 10, y: 300, w: 30, h: 10 })).toBeGreaterThan(0.3);
    expect(inkDifference(half, white, { x: 10, y: 10, w: 30, h: 10 })).toBe(0);
  });

  it('řádky schované pod jiným obsahem vynechá, obdélník z OCR nechá celý', () => {
    const rect = { page: 1, x: 50, y: 180, w: 300, h: 40, cover: [[50, 180, 300, 12], [50, 200, 300, 12], [50, 214, 300, 12]] as [number, number, number, number][] };
    expect(visiblePart(rect, geometry, half, white)).toMatchObject({ y: 200, h: 26, cover: rect.cover.slice(1) });
    expect(visiblePart({ ...rect, y: 10, cover: [[50, 10, 300, 12]] }, geometry, half, white)).toBeNull();
    const ocr = { page: 1, x: 50, y: 10, w: 300, h: 40 };
    expect(visiblePart(ocr, geometry, half, white)).toBe(ocr);
    expect(visiblePart({ ...rect, y: 10, cover: [[50, 10, 300, 12]] }, { ...geometry, invisible: true }, half, white)).not.toBeNull();
  });
});

describe('text pod lištou webu', () => {
  const geometry: PageGeometry = { view: [0, 0, 600, 800], rotate: 0, width: 600, height: 800 };
  const white = { width: 600, height: 800, data: new Uint8Array(600 * 800 * 4).fill(255) };
  // Písmo začíná až na řádku 206: nahoře v rámečku řádku (200–212) leží lišta, která text schovává.
  const clipped = { ...white, data: white.data.map((v, i) => (i >= 600 * 4 * 206 && Math.floor(i / 4) % 3 === 0 && i % 4 < 3 ? 0 : v)) };

  it('první viditelný řádek začne až pod lištou, plocha nezasahuje nad písmo', () => {
    const rect = { page: 1, x: 50, y: 180, w: 300, h: 46, cover: [[50, 180, 300, 12], [50, 200, 300, 12], [50, 214, 300, 12]] as [number, number, number, number][] };
    const part = visiblePart(rect, geometry, clipped, white)!;
    expect(part.y).toBeCloseTo(207.5, 5);
    expect(part.cover![0][1]).toBeCloseTo(207.5, 5);
    expect(part.y + part.h).toBe(226);
    // Plocha překryje i s okrajem PAD jen od prvních pixelů písma, tedy ne nad řádek 206.
    expect(part.cover![0][1] - 1.5).toBeGreaterThanOrEqual(206);
  });

  it('bez schovaných řádků nad ním nic neposouvá', () => {
    const rect = { page: 1, x: 50, y: 200, w: 300, h: 26, cover: [[50, 200, 300, 12], [50, 214, 300, 12]] as [number, number, number, number][] };
    expect(visiblePart(rect, geometry, clipped, white)).toBe(rect);
  });
});

describe('volné místo pod odstavcem', () => {
  const white = { width: 600, height: 800, data: new Uint8Array(600 * 800 * 4).fill(255) };
  const black = (image: typeof white, x: number, y: number) => image.data.set([0, 0, 0, 255], (y * image.width + x) * 4);

  it('změří prázdný pás až k dalšímu obsahu', () => {
    const image = { ...white, data: white.data.slice() };
    for (let x = 60; x < 80; x++) black(image, x, 275);
    expect(blankBelow(image, { x: 50, y: 200, w: 300, h: 50 }, [1, 1, 1], 1)).toBe(23);
  });

  it('pás je nejvýš 40 bodů a okraj jemně odlišné plochy ho ukončí', () => {
    expect(blankBelow(white, { x: 50, y: 100, w: 300, h: 20 }, [1, 1, 1], 1)).toBe(40);
    const grey = { ...white, data: white.data.slice() };
    for (let x = 0; x < 600; x++) grey.data.set([250, 250, 250, 255], (130 * 600 + x) * 4);
    expect(blankBelow(grey, { x: 50, y: 100, w: 300, h: 20 }, [1, 1, 1], 1)).toBeLessThan(10);
  });

  it('využije volné místo, než zmenší písmo', () => {
    const text = 'slovo '.repeat(60);
    const small = fitText(text, { w: 200, h: 60 }, 12, measure);
    const roomy = fitText(text, { w: 200, h: 60 + 40 }, 12, measure);
    expect(small.size).toBeLessThan(12);
    expect(roomy.size).toBeGreaterThan(small.size);
  });
});

describe('buildLayoutPdf', () => {
  it('překryje text překladem, otočenou stránku nechá', async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    source.addPage([600, 800]).setRotation(degrees(90));
    const input = await source.save();
    const pages = new Map<number, PageGeometry>([
      [1, { view: [0, 0, 600, 800], rotate: 0, width: 600, height: 800 }],
      [2, { view: [0, 0, 600, 800], rotate: 90, width: 800, height: 600 }],
    ]);
    const segments: Segment[] = [
      { id: 0, kind: 'paragraph', source: 'Hello', translation: 'Dobrý den, žluťoučký kůň', rects: [{ page: 1, x: 50, y: 50, w: 300, h: 14 }], fontSize: 10 },
      { id: 1, kind: 'paragraph', source: 'Long', translation: 'slovo '.repeat(200), rects: [{ page: 1, x: 50, y: 100, w: 100, h: 12 }], fontSize: 10 },
      { id: 2, kind: 'paragraph', source: 'Rotated', translation: 'Otočeno', rects: [{ page: 2, x: 50, y: 50, w: 100, h: 12 }] },
    ];
    const white = { width: 600, height: 800, data: new Uint8Array(600 * 800 * 4).fill(255) };
    // S textem: každý třetí pixel tmavý (pozadí zůstane bílé), bez textu bílá stránka.
    const inked = { ...white, data: white.data.map((v, i) => (Math.floor(i / 4) % 3 === 0 && i % 4 < 3 ? 0 : v)) };
    const result = await buildLayoutPdf(input, segments, pages, {
      fontsDir: FONTS,
      pageImage: async (_page, noText) => (noText ? white : inked),
      text: (s) => s.translation ?? '',
    });
    expect(result.rotated).toEqual([2]);
    expect([...result.overflow.keys()].map((s) => s.id)).toEqual([1]);
    const out = await PDFDocument.load(result.pdf);
    expect(out.getPageCount()).toBe(2);
  });
});
