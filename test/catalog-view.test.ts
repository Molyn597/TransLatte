import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogRows, filterCatalog, formatContext, sharedModel, sortCatalog, visionWarnings } from '../src/shared/catalog-view';
import { FAST_REMOTE_MODEL, RECOMMENDED_REMOTE_MODEL } from '../src/shared/provider';
import { fetchCatalog, refreshCatalog, resetCatalogCache, catalogAt } from '../src/main/provider';

const m = (key: string, vision: boolean, output?: number) => ({
  key,
  name: key.toUpperCase(),
  vision,
  sizeBytes: 0,
  price: output === undefined ? undefined : { input: 0, output },
});
const catalog = [m('a/text-cheap', false, 0.1), m('b/vis-pricey', true, 5), m('c/vis-cheap', true, 1), m(RECOMMENDED_REMOTE_MODEL, true, 9), m('d/noprice', true), m(FAST_REMOTE_MODEL, true, 8)];

describe('catalog-view', () => {
  it('filtruje podle slov a obrazu, vybraný model nechá', () => {
    expect(filterCatalog(catalog, { text: '', visionOnly: true }).map((x) => x.key)).not.toContain('a/text-cheap');
    expect(filterCatalog(catalog, { text: 'VIS cheap', visionOnly: false }).map((x) => x.key)).toEqual(['c/vis-cheap']);
    expect(filterCatalog(catalog, { text: 'zzz', visionOnly: true, keep: ['a/text-cheap'] }).map((x) => x.key)).toEqual(['a/text-cheap']);
  });

  it('řadí: doporučený, rychlá alternativa, obraz, cena výstupu', () => {
    expect(sortCatalog(catalog).map((x) => x.key)).toEqual([RECOMMENDED_REMOTE_MODEL, FAST_REMOTE_MODEL, 'c/vis-cheap', 'b/vis-pricey', 'd/noprice', 'a/text-cheap']);
  });

  it('nástroje s placeným vstupem a nulovým výstupem řadí až na konec', () => {
    const tool = { ...m('s/summarize', true, 0), price: { input: 0.04, output: 0 } };
    expect(sortCatalog([tool, m('a/text-cheap', false, 0.1), m('c/vis-cheap', true, 1)]).map((x) => x.key)).toEqual(['c/vis-cheap', 'a/text-cheap', 's/summarize']);
  });

  it('ořízne na limit a vrátí celkový počet', () => {
    const many = Array.from({ length: 120 }, (_, i) => m(`x/${i}`, true, i));
    const { rows, total } = catalogRows(many, { text: '', visionOnly: true });
    expect([rows.length, total]).toEqual([50, 120]);
  });

  it('pozná jeden model pro všechny role', () => {
    expect(sharedModel({ ocr: 'x', translate: 'x', polish: 'x' })).toBe('x');
    expect(sharedModel({ ocr: 'x', translate: 'y', polish: 'x' })).toBeUndefined();
  });

  it('varuje jen u OCR a oprav bez obrazu', () => {
    const w = visionWarnings({ ocr: 'a/text-cheap', translate: 'a/text-cheap', polish: 'a/text-cheap' }, catalog);
    expect(w.map((x) => x.role)).toEqual(['ocr', 'polish']);
    expect(visionWarnings({ ocr: 'b/vis-pricey', translate: 'a/text-cheap', polish: 'unknown' }, catalog)).toEqual([]);
  });

  it('formátuje kontext', () => {
    expect([formatContext(262144), formatContext(1048576), formatContext(undefined)]).toEqual(['262k', '1M', '—']);
  });
});

describe('refresh katalogu', () => {
  beforeEach(() => {
    resetCatalogCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a/b', context_length: 1000 }] }))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('obejde mezipaměť', async () => {
    await fetchCatalog();
    await fetchCatalog();
    expect(fetch).toHaveBeenCalledTimes(1);
    const models = await refreshCatalog();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(models[0].context).toBe(1000);
    expect(catalogAt()).toBeGreaterThan(0);
  });
});
