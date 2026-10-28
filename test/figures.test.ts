import { describe, expect, it } from 'vitest';
import { captionKind, findFigureRegions, type Block } from '../src/main/segments';

const size = new Map([[1, { width: 600, height: 800 }]]);
const block = (text: string, y: number, h: number, extra: Partial<Block> = {}): Block => ({
  kind: 'paragraph',
  text,
  page: 1,
  rects: [{ page: 1, x: 60, y, w: 480, h }],
  ...extra,
});
const body = (y: number) => block('Lorem ipsum dolor sit amet. '.repeat(10), y, 60);

describe('captionKind', () => {
  it('pozná popisky tabulek a grafů', () => {
    expect(captionKind('Table 1. Average number of late-coming parents')).toBe('table');
    expect(captionKind('TABLE 5')).toBe('table');
    expect(captionKind('Figure 2: Fines over time')).toBe('figure');
    expect(captionKind('Obrázek 3 – Vývoj')).toBe('figure');
  });

  it('věta odkazující na tabulku popisek není', () => {
    expect(captionKind('Table 1 shows the average number of parents.')).toBeUndefined();
    expect(captionKind('Tables are useful.')).toBeUndefined();
  });
});

describe('findFigureRegions', () => {
  it('tabulka pod popiskem až k dalšímu odstavci', () => {
    const caption = block('Table 1. Results', 200, 14);
    const row = block('Group 1 10 12', 230, 12, { kind: 'table' });
    const blocks = [body(100), caption, row, body(400)];
    const [region] = findFigureRegions(blocks, size);
    expect(region.caption).toBe(caption);
    expect(region.position).toBe('after');
    expect(region.members).toEqual([row]);
    expect(region.y0).toBeCloseTo(214);
    expect(region.y1).toBe(400);
  });

  it('graf nad popiskem', () => {
    const label = block('Week', 250, 10, { figure: true, layoutOnly: true });
    const caption = block('Figure 1. Late parents per week', 380, 14);
    const [region] = findFigureRegions([body(100), label, caption, body(450)], size);
    expect(region.position).toBe('before');
    expect(region.members).toEqual([label]);
    expect(region.y0).toBe(160);
    expect(region.y1).toBe(380);
  });

  it('popisek bez místa pro obsah se přeskočí', () => {
    expect(findFigureRegions([body(100), block('Table 2. Empty', 165, 14), body(185)], size)).toEqual([]);
  });
});

describe('findFigureRegions – dva grafy pod sebou', () => {
  it('druhý popisek nepřebere oblast prvního', () => {
    const first = block('Figure 1.—Late parents', 216, 10);
    const second = block('Figure 2.—Median delay', 419, 28);
    const regions = findFigureRegions([first, second, body(514)], size);
    expect(regions.map((r) => r.position)).toEqual(['before', 'before']);
    expect(regions[1].y0).toBeCloseTo(226);
  });
});

describe('findFigureRegions – popisek slitý se záhlavím', () => {
  it('záhlaví tabulky z popisku zůstane v obrázku', () => {
    const caption: Block = {
      kind: 'paragraph',
      text: 'TABLE 2 Average Number of Parents No. of Children',
      page: 1,
      rects: [
        { page: 1, x: 100, y: 85, w: 220, h: 33, chars: 34 },
        { page: 1, x: 107, y: 132, w: 40, h: 19, chars: 15 },
      ],
    };
    const [region] = findFigureRegions([caption, block('1 37 7.25', 155, 10, { kind: 'table' }), body(300)], size);
    expect(region.y0).toBe(118);
    expect(caption.text).toBe('TABLE 2 Average Number of Parents');
    expect(caption.rects).toHaveLength(1);
  });
});
