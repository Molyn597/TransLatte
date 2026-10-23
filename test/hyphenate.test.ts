import { describe, expect, it } from 'vitest';
import { hyphenParts } from '../src/main/hyphenate';

describe('hyphenParts', () => {
  it('rozdělí české slovo', () => {
    expect(hyphenParts('Strukturální', 'cs')).toEqual(['Struk', 'tu', 'rální']);
  });

  it('krátké slovo nedělí', () => {
    expect(hyphenParts('okno', 'cs')).toEqual(['okno']);
    expect(hyphenParts('domov', 'cs')).toEqual(['domov']);
  });

  it('interpunkce zůstane u krajních částí', () => {
    const parts = hyphenParts('(výkonnosti),', 'cs');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('(výkonnosti),');
    expect(parts[0].startsWith('(')).toBe(true);
    expect(parts.at(-1)!.endsWith('),')).toBe(true);
  });

  it('zkratky velkými písmeny nedělí', () => {
    expect(hyphenParts('ERC', 'cs')).toEqual(['ERC']);
    expect(hyphenParts('FDA-schválený', 'en')).toEqual(['FDA-schválený']);
  });

  it('slova s číslicí nedělí', () => {
    expect(hyphenParts('COVID19', 'cs')).toEqual(['COVID19']);
    expect(hyphenParts('výkonnost2024', 'cs')).toEqual(['výkonnost2024']);
  });

  it('URL a e-maily nedělí', () => {
    for (const w of ['https://example.com/dlouhacesta', 'www.dlouhastranka.cz', 'jmenoprijmeni@example.com']) {
      expect(hyphenParts(w, 'cs')).toEqual([w]);
    }
  });

  it('s pevným spojovníkem lomí jen za ním', () => {
    expect(hyphenParts('Check-in', 'en')).toEqual(['Check-', 'in']);
    expect(hyphenParts('e-mailem', 'cs')).toEqual(['e-', 'mailem']);
    expect(hyphenParts('(Check-in).', 'en')).toEqual(['(Check-', 'in).']);
  });

  it('dělí angličtinu', () => {
    const parts = hyphenParts('performance', 'en');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('performance');
  });

  it('slova s apostrofem nedělí', () => {
    expect(hyphenParts("Alzheimer's", 'en')).toEqual(["Alzheimer's"]);
  });

  it('nepodporovaný jazyk nedělí', () => {
    expect(hyphenParts('Strukturální', 'de')).toEqual(['Strukturální']);
  });

  it('dodrží minimum 2 písmena na začátku a 3 na konci', () => {
    for (const w of ['Strukturální', 'výkonnosti', 'nejvýznamnější', 'ovlivnění', 'automatizace']) {
      const parts = hyphenParts(w, 'cs');
      expect(parts.join('')).toBe(w);
      expect(parts[0].length).toBeGreaterThanOrEqual(2);
      expect(parts.at(-1)!.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('je deterministická', () => {
    expect(hyphenParts('Strukturální', 'cs')).toEqual(hyphenParts('Strukturální', 'cs'));
  });
});
