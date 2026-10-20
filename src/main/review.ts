import type { DocumentContext, GlossaryEntry, Mode, Segment } from '../shared/types';
import { fixPrepositions, untranslatedWords } from './czech';
import { fixCzechMonths } from './dates';
import { glossaryMisses, hasRepetition, suspiciousLength } from './quality';

export type IssueKind = 'spelling' | 'untranslated' | 'glossary' | 'suspicious' | 'gender';

export interface Issue {
  kind: IssueKind;
  /** Český popis pro upozornění v UI i pro korektora. */
  text: string;
  /** Totéž anglicky pro korektora u jiných cílových jazyků než čeština. */
  en: string;
  /** Počet chyb (slov, termínů), podle něj se posuzuje, jestli oprava pomohla. */
  count: number;
}

export interface ReviewOptions {
  sourceLang: string;
  targetLang: string;
  mode: Mode;
  glossary: GlossaryEntry[];
  context?: DocumentContext;
}

/** Deterministické opravy češtiny (předložky, měsíce ve 2. pádě). */
export const fixCzech = (text: string) => fixPrepositions(fixCzechMonths(text));

export function applyDeterministic(segments: Segment[], targetLang: string) {
  if (targetLang !== 'cs') return;
  for (const s of segments) {
    if (s.translation) s.translation = fixCzech(s.translation);
    if (s.polished) s.polished = fixCzech(s.polished);
  }
}

/**
 * Vynucuje se jen uživatelský glosář. Termíny z kontextu generuje model nespolehlivě
 * („Check-in (běžné zpětné vazby)“, azbuka), zůstávají jen v job.context jako podklad pro navržený glosář.
 */
export const reviewGlossary = (o: Pick<ReviewOptions, 'glossary'>): GlossaryEntry[] => o.glossary;

// Příčestí minulé v 1. osobě: „jsem uvedl“, „jsem si uvědomil“, „uvědomil jsem si“.
const pastWith = (ending: string) =>
  new RegExp(
    `(?<!\\p{L})jsem\\s+(?:s[ei]\\s+)?\\p{L}+${ending}(?!\\p{L})|(?<!\\p{L})\\p{L}+${ending}\\s+jsem(?!\\p{L})`,
    'giu',
  );
const MASCULINE = pastWith('l');
const FEMININE = pastWith('la');

/** Slovesa v 1. osobě minulého času v rodě, který neodpovídá autorovi. */
export function wrongGender(translation: string, gender: DocumentContext['authorGender']): string[] {
  if (gender === 'unknown') return [];
  return [...new Set([...translation.matchAll(gender === 'female' ? MASCULINE : FEMININE)].map((m) => m[0].replace(/\s+/g, ' ')))];
}

const list = (items: string[]) => items.join(', ');

/** Problémy jednoho segmentu. `misspelled` je výsledek kontroly pravopisu (jen čeština). */
export function findIssues(
  seg: Pick<Segment, 'kind' | 'source'>,
  translation: string,
  misspelled: string[],
  o: ReviewOptions,
): Issue[] {
  if (seg.kind === 'table') return [];
  const cs = o.targetLang === 'cs';
  const issues: Issue[] = [];

  if (cs && misspelled.length) {
    issues.push({
      kind: 'spelling',
      text: `Pravděpodobné překlepy: ${list(misspelled)}.`,
      en: `Probable typos: ${list(misspelled)}.`,
      count: misspelled.length,
    });
  }

  if (o.sourceLang === 'en' && o.targetLang !== 'en') {
    const words = untranslatedWords(translation);
    if (words.length >= 2) {
      issues.push({
        kind: 'untranslated',
        text: `Nepřeložená anglická slova: ${list(words)}.`,
        en: `Untranslated English words: ${list(words)}.`,
        count: words.length,
      });
    }
  }

  const missing = glossaryMisses(seg.source, translation, reviewGlossary(o)).map((g) => `${g.source} → ${g.target}`);
  if (missing.length) {
    issues.push({
      kind: 'glossary',
      text: `Chybí termín z glosáře: ${list(missing)}.`,
      en: `Missing glossary term: ${list(missing)}.`,
      count: missing.length,
    });
  }

  if (hasRepetition(translation)) {
    issues.push({ kind: 'suspicious', text: 'Překlad obsahuje opakující se text.', en: 'The translation contains repeated text.', count: 1 });
  } else if (suspiciousLength(seg.source, translation)) {
    const short = translation.length < seg.source.length;
    issues.push({
      kind: 'suspicious',
      text: `Překlad je podezřele ${short ? 'krátký' : 'dlouhý'} vůči originálu (může být neúplný nebo vymyšlený).`,
      en: `The translation is suspiciously ${short ? 'short' : 'long'} compared to the original (possibly incomplete or invented).`,
      count: 1,
    });
  }

  if (cs && o.mode === 'quality' && o.context) {
    const wrong = wrongGender(translation, o.context.authorGender);
    if (wrong.length) {
      const [author, used] = o.context.authorGender === 'female' ? ['žena', 'mužský'] : ['muž', 'ženský'];
      issues.push({
        kind: 'gender',
        text: `Autor je ${author}, ale překlad používá ${used} rod: ${wrong.map((w) => `„${w}“`).join(', ')}.`,
        en: '',
        count: wrong.length,
      });
    }
  }
  return issues;
}

export const issueCount = (issues: Issue[]) => issues.reduce((n, i) => n + i.count, 0);

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Počet změněných slov (nahrazená + vložená + smazaná) podle LCS diffu; náhrada slova se počítá jednou. */
export function changedWords(before: string, after: string): number {
  let a = tokens(before);
  let b = tokens(after);
  // Opravy bývají místní: společný začátek a konec se do diffu nepočítá (i kvůli paměti u dlouhých odstavců).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  a = a.slice(start, a.length - end);
  b = b.slice(start, b.length - end);
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  // Průchod diffem: v každém úseku mezi shodami se smazaná a vložená slova párují jako náhrady.
  let changed = 0;
  let del = 0;
  let ins = 0;
  const flush = () => {
    changed += Math.max(del, ins);
    del = ins = 0;
  };
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      del++;
      i++;
    } else {
      ins++;
      j++;
    }
  }
  flush();
  return changed;
}

/** Oprava se přijme, jen když změní nejvýš pár slov na problém a problémů po ní nepřibude. */
export function acceptFix(source: string, before: string, after: string, beforeIssues: Issue[], afterIssues: Issue[]) {
  if (!after.trim()) return false;
  if (beforeIssues.some((i) => i.kind === 'suspicious')) {
    const ratio = after.length / Math.max(source.length, 1);
    if (ratio < 0.6 || ratio > 1.8) return false;
  } else if (changedWords(before, after) > Math.max(4, 3 * issueCount(beforeIssues))) {
    return false;
  }
  return issueCount(afterIssues) <= issueCount(beforeIssues);
}

/** Kontext dokumentu z odpovědi modelu: bez ```json ohrad, první {...} blok; při chybě undefined. */
export function parseContext(text: string): DocumentContext | undefined {
  const body = text.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = start; i < body.length && end < 0; i++) {
    const c = body[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) end = i;
  }
  if (end < 0) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const gender = str(d.authorGender).toLowerCase();
  const terms = Array.isArray(d.terms) ? d.terms : [];
  return {
    topic: str(d.topic),
    domain: str(d.domain),
    author: str(d.author),
    authorGender: gender === 'female' || gender === 'male' ? gender : 'unknown',
    audience: str(d.audience),
    terms: terms
      .map((t) => ({ source: str((t as Record<string, unknown>)?.source), target: str((t as Record<string, unknown>)?.target) }))
      .filter((t) => t.source && t.target),
  };
}
