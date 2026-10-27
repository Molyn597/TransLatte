import { t, locale } from './i18n';
import { CHARS_PER_PAGE, estimateCost } from './cost';
import { selectPages } from './pages';
import { isFreeModel } from './provider';
import type { Currency, FileInfo, Mode, ModelPrice, Models } from './types';

let czkRate: number | undefined;
let currency: Currency = 'both';

/** Kurz USD → CZK; bez něj se ceny ukazují jen v dolarech. */
export const setCzkRate = (rate?: number) => (czkRate = rate);
export const setCurrency = (next: Currency) => (currency = next);

/** Koruny: od 10 Kč celé, níž na 2 desetinná místa, pod 0,01 Kč „< 0,01 Kč“. */
function formatCzk(amount: number, loc: string) {
  if (amount > 0 && amount < 0.01) return t('cost.czkTiny');
  const digits = amount >= 10 ? 0 : 2;
  return t('cost.czk', { amount: amount.toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits }) });
}

/** Částka v USD: od 0,1 na 2 desetinná místa, níž na 3, pod 0,001 „< 0,001 $“; se známým kurzem i (nebo jen) v Kč. */
export function formatUsd(amount: number, loc: string = locale(), rate = czkRate, cur = currency) {
  const digits = amount >= 0.1 ? 2 : 3;
  const usd =
    amount > 0 && amount < 0.001
      ? t('cost.tiny')
      : t('cost.value', { amount: amount.toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits }) });
  if (!rate || cur === 'usd') return usd;
  const czk = formatCzk(amount * rate, loc);
  return cur === 'czk' ? czk : t('cost.withCzk', { usd, czk });
}

export interface FileEstimateInput {
  files: FileInfo[];
  pageRange?: string;
  mode: Mode;
  models: Models;
  prices: Record<string, ModelPrice | undefined>;
  factors?: Record<string, number>;
}

export interface FileEstimate {
  /** Odhad v USD; bez hodnoty, když chybí cena modelu nebo není co odhadovat. */
  usd?: number;
  /** Všechny použité modely jsou bezplatné. */
  free: boolean;
  /** Stránky (u textu přepočtené podle znaků). */
  pages: number;
  /** Je mezi soubory Word, jehož rozsah se zjistí až po načtení. */
  unknownDocx: boolean;
}

/** Součet odhadů přes všechny vybrané soubory; PDF respektuje rozsah stránek. */
export function estimateFiles({ files, pageRange, mode, models, prices, factors }: FileEstimateInput): FileEstimate {
  let chars = 0;
  let pages = 0;
  let unknownDocx = false;
  for (const f of files) {
    if (f.kind === 'docx') unknownDocx = true;
    else if (f.kind === 'text') {
      chars += f.chars;
      pages += Math.ceil(f.chars / CHARS_PER_PAGE);
    } else {
      let count = f.pages;
      try {
        count = selectPages(pageRange, f.pages).length;
      } catch {
        // Neplatný rozsah se řeší při přidání úlohy; odhad počítá celý dokument.
      }
      chars += count * CHARS_PER_PAGE;
      pages += count;
    }
  }
  const free = Object.values(models).every(isFreeModel);
  if (!chars) return { free, pages, unknownDocx };
  const usd = free ? 0 : estimateCost({ chars, mode, models, prices }, factors);
  return { usd, free, pages, unknownDocx };
}
