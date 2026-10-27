import { describe, expect, it } from 'vitest';
import { CHARS_PER_PAGE, estimateCost } from '../src/shared/cost';
import { estimateFiles, formatUsd } from '../src/shared/estimate';
import { setLang } from '../src/shared/i18n';

const one = (id: string) => ({ ocr: id, translate: id, polish: id });
const prices = { ds: { input: 0.14, output: 0.42 }, free: { input: 0, output: 0 } };
const base = { mode: 'balanced' as const, models: one('ds'), prices };

describe('formatUsd s korunami', () => {
  it('přidá Kč podle kurzu', () => {
    setLang('cs');
    expect(formatUsd(0.0214, 'cs-CZ', 21.834)).toBe('0,021 $ (≈ 0,47 Kč)');
    expect(formatUsd(1.2, 'cs-CZ', 21.834)).toBe('1,20 $ (≈ 26 Kč)');
    expect(formatUsd(0.0002, 'cs-CZ', 21.834)).toBe('< 0,001 $ (≈ < 0,01 Kč)');
  });

  it('měna podle nastavení; bez kurzu vždy dolary', () => {
    setLang('cs');
    expect(formatUsd(0.0214, 'cs-CZ', 21.834, 'czk')).toBe('0,47 Kč');
    expect(formatUsd(0.0214, 'cs-CZ', 21.834, 'usd')).toBe('0,021 $');
    expect(formatUsd(0.0214, 'cs-CZ', undefined, 'czk')).toBe('0,021 $');
  });
});

describe('formatUsd', () => {
  it('od 0,1 dvě desetinná místa, níž tři, pod 0,001 zkráceně', () => {
    setLang('cs');
    expect(formatUsd(1.234, 'en-GB')).toBe('1.23 $');
    expect(formatUsd(0.1, 'en-GB')).toBe('0.10 $');
    expect(formatUsd(0.0214, 'en-GB')).toBe('0.021 $');
    expect(formatUsd(0.0004, 'en-GB')).toBe('< 0,001 $');
  });

  it('angličtina dává symbol dolaru před částku', () => {
    setLang('en');
    expect(formatUsd(0.5, 'en-GB')).toBe('$0.50');
    expect(formatUsd(0.0004, 'en-GB')).toBe('< $0.001');
    setLang('cs');
  });
});

describe('estimateFiles', () => {
  it('PDF počítá stránky × znaky na stránku, rozsah ho zkrátí', () => {
    const files = [{ kind: 'pdf' as const, pages: 10 }];
    const all = estimateFiles({ ...base, files });
    expect(all.pages).toBe(10);
    expect(all.usd).toBeCloseTo(estimateCost({ ...base, chars: 10 * CHARS_PER_PAGE })!);
    const part = estimateFiles({ ...base, files, pageRange: '1-3, 5' });
    expect(part.pages).toBe(4);
    expect(part.usd).toBeCloseTo(estimateCost({ ...base, chars: 4 * CHARS_PER_PAGE })!);
  });

  it('sčítá soubory, text podle znaků, Word jen označí', () => {
    const r = estimateFiles({ ...base, files: [{ kind: 'pdf', pages: 2 }, { kind: 'text', chars: 6000 }, { kind: 'docx' }] });
    expect(r.unknownDocx).toBe(true);
    expect(r.pages).toBe(4);
    expect(r.usd).toBeCloseTo(estimateCost({ ...base, chars: 4 * CHARS_PER_PAGE })!);
  });

  it('koeficient zpřesní odhad', () => {
    const files = [{ kind: 'text' as const, chars: 9000 }];
    const plain = estimateFiles({ ...base, files }).usd!;
    expect(estimateFiles({ ...base, files, factors: { ds: 2 } }).usd).toBeCloseTo(plain * 2);
  });

  it('jen Word nemá číslo; neznámá cena také ne', () => {
    const docx = estimateFiles({ ...base, files: [{ kind: 'docx' }] });
    expect(docx.usd).toBeUndefined();
    expect(docx.unknownDocx).toBe(true);
    expect(estimateFiles({ ...base, models: one('nope'), files: [{ kind: 'text', chars: 100 }] }).usd).toBeUndefined();
  });

  it('bezplatné modely jsou zdarma bez ohledu na cenu', () => {
    const r = estimateFiles({ ...base, models: one('x:free'), files: [{ kind: 'pdf', pages: 3 }] });
    expect(r).toMatchObject({ free: true, usd: 0 });
  });
});
