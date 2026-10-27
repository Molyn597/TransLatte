import { describe, expect, it } from 'vitest';
import { parseCnbUsd } from '../src/main/fx';

describe('kurz ČNB', () => {
  it('najde USD a přepočte na 1 jednotku', () => {
    const text = '27.10.2026 #207\nzemě|měna|množství|kód|kurz\nAustrálie|dolar|1|AUD|15,354\nUSA|dolar|1|USD|21,834\nJaponsko|jen|100|JPY|14,321\n';
    expect(parseCnbUsd(text)).toBeCloseTo(21.834);
    expect(parseCnbUsd(text.replace('1|USD', '100|USD'))).toBeCloseTo(0.21834);
    expect(parseCnbUsd('nic')).toBeUndefined();
  });
});
