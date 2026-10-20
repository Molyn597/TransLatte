import { describe, expect, it } from 'vitest';
import { isValidPageRange, selectPages } from '../src/shared/pages';

describe('selectPages', () => {
  it('prázdný rozsah = všechny stránky', () => expect(selectPages('', 3)).toEqual([1, 2, 3]));
  it('rozsahy, jednotlivé stránky, mezery a obrácené pořadí', () =>
    expect(selectPages(' 1-3, 5 , 9-8', 10)).toEqual([1, 2, 3, 5, 8, 9]));
  it('stránky mimo dokument ignoruje', () => expect(selectPages('8-20', 10)).toEqual([8, 9, 10]));
  it('rozsah bez jediné stránky dokumentu je chyba', () => expect(() => selectPages('20-30', 10)).toThrow(/neobsahuje/));
  it('neplatný zápis odmítne', () => {
    expect(isValidPageRange('1-8')).toBe(true);
    expect(isValidPageRange('1-')).toBe(false);
    expect(isValidPageRange('strana 2')).toBe(false);
  });
});
