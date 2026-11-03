import { describe, expect, it } from 'vitest';
import type { Segment } from '../src/shared/types';
import {
  cleanCitations,
  formatPassages,
  passages,
  search,
  selectPassages,
  terms,
  type Passage,
} from '../src/main/rag';

const seg = (over: Partial<Segment> & { id: number }): Segment => ({
  kind: 'paragraph',
  source: '',
  ...over,
});

const passage = (over: Partial<Passage> & { id: number }): Passage => ({
  heading: false,
  text: '',
  search: '',
  ...over,
});

describe('terms', () => {
  it('sjednotí diakritiku a velikost písmen', () => {
    expect(terms('Výpověď')).toEqual(terms('VYPOVED'));
    expect(terms('Účinnost')).toEqual(['ucinn']);
  });

  it('ořeže slova na 5 znaků', () => {
    expect(terms('zákona')).toEqual(['zakon']);
    expect(terms('zákonem')).toEqual(['zakon']);
  });

  it('čísla zůstanou celá', () => {
    expect(terms('§ 52')).toEqual(['52']);
  });

  it('vynechá krátká slova a stop-slova', () => {
    expect(terms('the jaky ok')).toEqual([]);
  });
});

describe('passages', () => {
  it('vynechá layoutOnly, figure, inSnapshot a prázdný source', () => {
    const items = passages([
      seg({ id: 1, source: 'A', layoutOnly: true }),
      seg({ id: 2, source: 'B', figure: true }),
      seg({ id: 3, source: 'C', inSnapshot: true }),
      seg({ id: 4, source: '   ' }),
      seg({ id: 5, source: 'D' }),
    ]);
    expect(items.map((p) => p.id)).toEqual([5]);
  });

  it('přeložený segment: text je finální překlad, search obsahuje originál i překlad', () => {
    const [p] = passages([seg({ id: 1, source: 'Notice period', translation: 'Výpovědní lhůta', polished: 'Výpovědní lhůta, upraveno' })]);
    expect(p.text).toBe('Výpovědní lhůta, upraveno');
    expect(p.search).toContain('Notice period');
    expect(p.search).toContain('Výpovědní lhůta, upraveno');
  });

  it('edited má přednost před polished', () => {
    const [p] = passages([seg({ id: 1, source: 'X', translation: 'T', polished: 'P', edited: 'E' })]);
    expect(p.text).toBe('E');
  });

  it('skipped nebo nepřeložený segment: text je source', () => {
    const [skipped, untranslated] = passages([
      seg({ id: 1, source: 'Skip me', translation: 'Přeskoč', skipped: true }),
      seg({ id: 2, source: 'Not yet' }),
    ]);
    expect(skipped.text).toBe('Skip me');
    expect(untranslated.text).toBe('Not yet');
  });

  it('heading podle kind === heading', () => {
    const [h, p] = passages([
      seg({ id: 1, kind: 'heading', source: 'Úvod' }),
      seg({ id: 2, kind: 'paragraph', source: 'Text' }),
    ]);
    expect(h.heading).toBe(true);
    expect(p.heading).toBe(false);
  });
});

describe('search', () => {
  const items = passages([
    seg({ id: 1, source: 'Výpovědní lhůty jsou tři měsíce.' }),
    seg({ id: 2, source: 'Dovolená činí čtyři týdny.' }),
    seg({ id: 3, source: 'Notice period is three months.' }),
  ]);

  it('najde slovo v jiném tvaru', () => {
    const hits = search(items, 'výpovědní lhůta', 5);
    expect(hits[0].id).toBe(1);
  });

  it('relevantnější segment je první', () => {
    const docs = passages([
      seg({ id: 1, source: 'Lhůta je krátká a jiná věc.' }),
      seg({ id: 2, source: 'Výpovědní lhůta, výpovědní lhůta, výpovědní lhůta.' }),
    ]);
    expect(search(docs, 'výpovědní lhůta', 5)[0].id).toBe(2);
  });

  it('anglický dotaz najde segment podle originálu i když překlad je česky', () => {
    const translated = passages([
      seg({ id: 1, source: 'Notice period is three months.', translation: 'Výpovědní lhůta jsou tři měsíce.' }),
      seg({ id: 2, source: 'Holiday is four weeks.', translation: 'Dovolená jsou čtyři týdny.' }),
    ]);
    expect(search(translated, 'notice period', 5)[0].id).toBe(1);
  });

  it('limit funguje', () => {
    const hits = search(items, 'lhůta měsíce dovolená týdny notice period', 1);
    expect(hits).toHaveLength(1);
  });

  it('prázdný dotaz vrátí []', () => {
    expect(search(items, '', 5)).toEqual([]);
    expect(search(items, 'the a', 5)).toEqual([]);
  });
});

describe('selectPassages', () => {
  const items: Passage[] = [
    passage({ id: 1, heading: true, text: 'Kapitola A' }),
    passage({ id: 2, text: 'Odstavec A1' }),
    passage({ id: 3, heading: true, text: 'Kapitola B' }),
    passage({ id: 4, text: 'Odstavec B1' }),
    passage({ id: 5, text: 'Odstavec B2' }),
  ];

  it('přidá nejbližší předchozí nadpis zásahu, v pořadí dokumentu', () => {
    const result = selectPassages(items, [items[4], items[1]], 1000);
    expect(result.map((p) => p.id)).toEqual([1, 2, 3, 5]);
  });

  it('přidá nadpis jen jednou a bez duplicit', () => {
    const result = selectPassages(items, [items[3], items[4]], 1000);
    expect(result.map((p) => p.id)).toEqual([3, 4, 5]);
  });

  it('nepřekročí maxChars', () => {
    const result = selectPassages(items, [items[1], items[3]], 'Odstavec A1'.length + 'Kapitola A'.length);
    const total = result.reduce((s, p) => s + p.text.length, 0);
    expect(total).toBeLessThanOrEqual('Odstavec A1'.length + 'Kapitola A'.length);
    expect(result.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe('cleanCitations', () => {
  it('rozdělí seznam citací na jednotlivé', () => {
    const r = cleanCitations('text [3, 5].', new Set([3, 5]));
    expect(r.text).toBe('text [3][5].');
    expect(r.sources).toEqual([3, 5]);
  });

  it('nepovolené id zahodí i s mezerou', () => {
    const r = cleanCitations('text [99].', new Set([3]));
    expect(r.text).toBe('text.');
    expect(r.sources).toEqual([]);
  });

  it('pořadí sources podle prvního výskytu bez duplicit', () => {
    const r = cleanCitations('A [5] B [3] C [5][3].', new Set([3, 5]));
    expect(r.sources).toEqual([5, 3]);
  });
});

describe('formatPassages', () => {
  it('formát „[id] (p. N) text“ a nadpis s „## “', () => {
    const out = formatPassages([
      passage({ id: 7, page: 4, heading: true, text: 'Úvod' }),
      passage({ id: 8, page: 4, text: 'Text  odstavce' }),
    ]);
    expect(out).toBe('[7] (p. 4) ## Úvod\n\n[8] (p. 4) Text odstavce');
  });

  it('bez stránky nevypisuje „(p. …)“', () => {
    expect(formatPassages([passage({ id: 2, text: 'Bez stránky' })])).toBe('[2] Bez stránky');
  });
});
