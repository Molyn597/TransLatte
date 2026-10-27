import type { Mode, ModelPrice, Models } from './types';

/** Hustě sázený článek; jen pro odhad před přečtením dokumentu. */
export const CHARS_PER_PAGE = 3000;

// Tokeny na znak zdroje, změřené na 8 online modelech (Gneezy str. 1–5, 10/2026).
const TRANSLATE = { input: 0.4, output: 0.27 };
const FIX = { input: 1.0, output: 0.05 };
const CONTEXT = { input: 2000, output: 400 };
const OCR_PAGE = { input: 1600, output: 1000 };

export interface CostInput {
  chars: number;
  mode: Mode;
  /** Stránky, které půjdou přes OCR (online jen skeny bez textové vrstvy). */
  ocrPages?: number;
  models: Models;
  prices: Record<string, ModelPrice | undefined>;
}

/** Odhad ceny v USD bez opravného koeficientu; bez ceny některého modelu nic. */
export function baseCost({ chars, mode, ocrPages = 0, models, prices }: CostInput): number | undefined {
  const usd = (model: string, input: number, output: number) => {
    const p = prices[model];
    return p ? (input * p.input + output * p.output) / 1e6 : NaN;
  };
  let total = usd(models.translate, chars * TRANSLATE.input, chars * TRANSLATE.output);
  if (mode !== 'fast') total += usd(models.polish, chars * FIX.input, chars * FIX.output);
  if (mode === 'quality') total += usd(models.polish, CONTEXT.input, CONTEXT.output);
  if (ocrPages) total += usd(models.ocr, ocrPages * OCR_PAGE.input, ocrPages * OCR_PAGE.output);
  return Number.isFinite(total) ? total : undefined;
}

/** Klíč koeficientu: sada modelů (většinou jeden model pro všechny role). */
export const costKey = (models: Models) => [...new Set(Object.values(models))].join('+');

export function estimateCost(input: CostInput, factors: Record<string, number> = {}) {
  const base = baseCost(input);
  return base === undefined ? undefined : base * (factors[costKey(input.models)] ?? 1);
}

/** Skutečná cena zpřesní koeficient sady modelů stejně jako odhad času (70 % staré, 30 % nové). */
export function calibrate(factors: Record<string, number>, key: string, base: number, actual: number) {
  if (!(base > 0) || !(actual > 0)) return factors;
  const ratio = Math.min(4, Math.max(0.25, actual / base));
  const old = factors[key];
  return { ...factors, [key]: old === undefined ? ratio : old * 0.7 + ratio * 0.3 };
}
