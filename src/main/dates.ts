import { t } from '../shared/i18n';
import { languageName } from '../shared/languages';

export type DateOrder = 'MDY' | 'DMY';

const CZECH_MONTHS: [string, string][] = [
  ['červenec', 'července'],
  ['červen', 'června'],
  ['leden', 'ledna'],
  ['únor', 'února'],
  ['březen', 'března'],
  ['duben', 'dubna'],
  ['květen', 'května'],
  ['srpen', 'srpna'],
  ['říjen', 'října'],
  ['listopad', 'listopadu'],
  ['prosinec', 'prosince'],
];

/** „6. KVĚTEN 2019“ → „6. KVĚTNA 2019“: za číslem dne musí být měsíc ve 2. pádě (zachová velká písmena). */
export function fixCzechMonths(text: string) {
  const names = CZECH_MONTHS.map(([n]) => n).join('|');
  return text.replace(new RegExp(`(\\d{1,2}\\.\\s*)(${names})(?!\\p{L})`, 'giu'), (_m, day: string, month: string) => {
    const genitive = CZECH_MONTHS.find(([n]) => n === month.toLowerCase())![1];
    if (month === month.toUpperCase()) return day + genitive.toUpperCase();
    if (month[0] === month[0].toUpperCase()) return day + genitive[0].toUpperCase() + genitive.slice(1);
    return day + genitive;
  });
}

// Datum se čtyřmístným rokem; číslo verze ani desetinné číslo tomu neodpovídá.
const NUMERIC = /(?<![\d.\/-])(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(?![\d\/-]|\.\d)/g;
const ISO = /(?<![\d.\/-])(\d{4})-(\d{2})-(\d{2})(?![\d\/-]|\.\d)/g;

/** Angličtina (USA) píše měsíc první, ostatní jazyky den. */
const languageOrder = (lang: string): DateOrder => (lang === 'en' ? 'MDY' : 'DMY');

/**
 * Pořadí dne a měsíce pro celý dokument: rozhodne datum, kde je jedno číslo větší než 12.
 * Když žádné takové není, platí zvyklost jazyka (undefined = rozhodla jen zvyklost).
 */
export function documentOrder(texts: string[]): DateOrder | undefined {
  let mdy = 0;
  let dmy = 0;
  for (const text of texts) {
    for (const [, a, , b] of text.matchAll(NUMERIC)) {
      if (Number(a) > 12 && Number(b) <= 12) dmy++;
      if (Number(b) > 12 && Number(a) <= 12) mdy++;
    }
  }
  if (mdy === dmy) return undefined;
  return mdy > dmy ? 'MDY' : 'DMY';
}

function valid(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const longDate = (lang: string, year: number, month: number, day: number) =>
  new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    Date.UTC(year, month - 1, day),
  );

/**
 * Přepíše číselná data na tvar s názvem měsíce ve zdrojovém jazyce („March 10, 2014“),
 * který překladový model přeloží správně. Nejednoznačná data (rozhodla jen zvyklost jazyka) vrátí v `notes`.
 */
export function rewriteDates(text: string, source: string, target: string, docOrder?: DateOrder) {
  const notes: string[] = [];
  const order = docOrder ?? languageOrder(source);
  let out = text.replace(NUMERIC, (match, a: string, _sep: string, b: string, y: string) => {
    const [first, second, year] = [Number(a), Number(b), Number(y)];
    let [month, day] = order === 'MDY' ? [first, second] : [second, first];
    if (month > 12 && day <= 12) [month, day] = [day, month]; // samo datum je jednoznačné
    if (!valid(year, month, day)) return match;
    if (first <= 12 && second <= 12 && first !== second && !docOrder) {
      const how = t(order === 'MDY' ? 'dates.monthDay' : 'dates.dayMonth');
      notes.push(t('dates.ambiguous', { date: match, read: longDate(target, year, month, day), how, lang: languageName(source) }));
    }
    return longDate(source, year, month, day);
  });
  out = out.replace(ISO, (match, y: string, m: string, d: string) =>
    valid(Number(y), Number(m), Number(d)) ? longDate(source, Number(y), Number(m), Number(d)) : match,
  );
  return { text: out, notes };
}
