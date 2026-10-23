import { describe, expect, it } from 'vitest';
import type { RegionTranslation } from '../src/shared/types';
import { findRegion, normalizeCrop, overlap, pendingSegments } from '../src/shared/regions';

const region = (page: number, crop: RegionTranslation['crop']): RegionTranslation => ({
  page,
  crop,
  text: 'x',
  createdAt: 0,
});

describe('overlap', () => {
  it('shodné výřezy = 1', () => expect(overlap([0.1, 0.1, 0.5, 0.5], [0.1, 0.1, 0.5, 0.5])).toBe(1));
  it('disjunktní výřezy = 0', () => expect(overlap([0, 0, 0.2, 0.2], [0.5, 0.5, 0.9, 0.9])).toBe(0));
  it('částečný překryv: průnik / sjednocení', () =>
    expect(overlap([0, 0, 0.5, 0.5], [0.25, 0, 0.75, 0.5])).toBeCloseTo(1 / 3));
});

describe('findRegion', () => {
  const regions = [region(1, [0.1, 0.1, 0.5, 0.5])];

  it('najde oblast na stejné stránce při malém posunu', () => {
    expect(findRegion(regions, 1, [0.101, 0.1, 0.501, 0.5])).toBe(regions[0]);
  });
  it('nenajde na jiné stránce ani při stejném výřezu', () => {
    expect(findRegion(regions, 2, [0.1, 0.1, 0.5, 0.5])).toBeUndefined();
  });
  it('nenajde při větším posunu', () => {
    expect(findRegion(regions, 1, [0.2, 0.1, 0.6, 0.5])).toBeUndefined();
  });
});

describe('normalizeCrop', () => {
  it('prohodí obrácené souřadnice', () => expect(normalizeCrop([0.5, 0.6, 0.1, 0.2])).toEqual([0.1, 0.2, 0.5, 0.6]));
  it('ořízne na 0–1', () => expect(normalizeCrop([-0.2, 0.3, 1.4, 1.1])).toEqual([0, 0.3, 1, 1]));
});

describe('pendingSegments', () => {
  it('vrátí jen segmenty bez skipped a bez translation', () => {
    const segments = [
      { id: 1 },
      { id: 2, translation: 'hotovo' },
      { id: 3, skipped: true },
      { id: 4, skipped: false, translation: undefined },
    ];
    expect(pendingSegments(segments).map((s) => s.id)).toEqual([1, 4]);
  });
});
