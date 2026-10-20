import type { GlossaryEntry } from '../shared/types';

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Shoda slov mezi textovou vrstvou PDF (reference) a výstupem OCR.
 * recall: kolik slov reference OCR zachytilo, precision: kolik slov OCR v referenci opravdu je.
 */
export function wordOverlap(reference: string, candidate: string) {
  const ref = words(reference);
  const cand = words(candidate);
  if (!ref.length || !cand.length) return { recall: ref.length ? 0 : 1, precision: cand.length ? 0 : 1 };
  const counts = new Map<string, number>();
  for (const w of ref) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of cand) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return { recall: common / ref.length, precision: common / cand.length };
}

/** Typická halucinace malých modelů: stejný řádek nebo stejná fráze dokola. */
export function hasRepetition(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 3);
  const lineCounts = new Map<string, number>();
  for (const l of lines) lineCounts.set(l, (lineCounts.get(l) ?? 0) + 1);
  if ([...lineCounts.values()].some((n) => n >= 4)) return true;

  const w = words(text);
  const grams = new Map<string, number>();
  for (let i = 0; i + 6 <= w.length; i++) {
    const g = w.slice(i, i + 6).join(' ');
    const n = (grams.get(g) ?? 0) + 1;
    if (n >= 4) return true;
    grams.set(g, n);
  }
  return false;
}

/** Překlad výrazně kratší nebo delší než originál bývá useknutý nebo vymyšlený. */
export function suspiciousLength(source: string, translation: string): boolean {
  if (source.length < 40) return false;
  const ratio = translation.length / source.length;
  return ratio < 0.45 || ratio > 2.2;
}

// Čeština skloňuje („velký model“ → „velkého modelu“), proto se hledají kmeny slov.
const stem = (word: string) => (word.length <= 4 ? word : word.slice(0, Math.max(4, Math.ceil(word.length * 0.7))));

function containsTerm(text: string, term: string, stems: boolean) {
  const haystack = words(text).join(' ');
  const needle = words(term);
  if (!needle.length) return false;
  if (!stems) return ` ${haystack} `.includes(` ${needle.join(' ')} `);
  const hayWords = haystack.split(' ');
  return needle.map(stem).every((s) => hayWords.some((w) => w.startsWith(s)));
}

/** Položky glosáře, jejichž termín je v originálu, ale v překladu chybí. */
export function glossaryMisses(source: string, translation: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  return glossary.filter(
    (g) => g.source.trim() && g.target.trim() && containsTerm(source, g.source, false) && !containsTerm(translation, g.target, true),
  );
}

export function relevantGlossary(source: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  return glossary.filter((g) => g.source.trim() && g.target.trim() && containsTerm(source, g.source, false));
}
