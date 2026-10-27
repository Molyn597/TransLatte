import { describe, expect, it } from 'vitest';
import { baseCost, calibrate, costKey, estimateCost } from '../src/shared/cost';

const one = (id: string) => ({ ocr: id, translate: id, polish: id });
const prices = { ds: { input: 0.14, output: 0.42 }, gem: { input: 0.25, output: 1.5 } };

describe('odhad ceny', () => {
  it('sedí na naměřený běh (Gneezy str. 1–5, kvalita, DeepSeek 0,0064 $)', () => {
    const usd = baseCost({ chars: 14621, mode: 'quality', models: one('ds'), prices })!;
    expect(usd).toBeGreaterThan(0.0064 / 1.5);
    expect(usd).toBeLessThan(0.0064 * 1.5);
  });

  it('rychlý režim je levnější než vyvážený a ten než kvalitní', () => {
    const cost = (mode: 'fast' | 'balanced' | 'quality') => baseCost({ chars: 30000, mode, models: one('ds'), prices })!;
    expect(cost('fast')).toBeLessThan(cost('balanced'));
    expect(cost('balanced')).toBeLessThan(cost('quality'));
  });

  it('OCR stránky přičte podle modelu OCR', () => {
    const models = { ocr: 'gem', translate: 'ds', polish: 'ds' };
    const without = baseCost({ chars: 3000, mode: 'fast', models, prices })!;
    expect(baseCost({ chars: 3000, mode: 'fast', ocrPages: 2, models, prices })! - without).toBeCloseTo((3200 * 0.25 + 2000 * 1.5) / 1e6);
  });

  it('bez ceny modelu není odhad', () => {
    expect(baseCost({ chars: 1000, mode: 'fast', models: one('neznámý'), prices })).toBeUndefined();
  });

  it('koeficient: první měření převezme, další míchá 70/30 a je omezený', () => {
    let f = calibrate({}, 'ds', 0.01, 0.02);
    expect(f.ds).toBe(2);
    f = calibrate(f, 'ds', 0.01, 0.01);
    expect(f.ds).toBeCloseTo(1.7);
    expect(calibrate({}, 'x', 0.01, 1).x).toBe(4);
    expect(calibrate(f, 'ds', 0, 0.01)).toBe(f);
  });

  it('odhad použije koeficient sady modelů', () => {
    const input = { chars: 10000, mode: 'fast' as const, models: one('ds'), prices };
    expect(estimateCost(input, { [costKey(one('ds'))]: 2 })).toBeCloseTo(baseCost(input)! * 2);
    expect(costKey({ ocr: 'a', translate: 'b', polish: 'a' })).toBe('a+b');
  });
});
