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

export interface AnchorRange {
  start: number;
  end: number;
}

const bare = (token: string) => token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const tokenize = (text: string) => text.split(/\s+/).map(bare).filter(Boolean);
// Odkaz bývá krátký („naše stránka“ → „naši stránku“), proto volnější kmen než u glosáře.
const looseStem = (word: string) => (word.length < 4 ? word : word.slice(0, Math.max(3, Math.ceil(word.length * 0.7))));

/** Okno `size` tokenů od `from`, ve kterém každé hledané slovo pokryje jiný token (pořadí se v překladu může změnit). */
function findWindow(tokens: string[], needle: string[], size: number, from: number, match: (token: string, word: string) => boolean) {
  for (let i = from; i + size <= tokens.length; i++) {
    const window = tokens.slice(i, i + size);
    const used = new Set<number>();
    const ok = needle.every((word) => {
      const j = window.findIndex((t, k) => !used.has(k) && match(t, word));
      if (j < 0) return false;
      used.add(j);
      return true;
    });
    // Okno nesmí začínat ani končit slovem navíc.
    if (ok && used.has(0) && used.has(size - 1)) return i;
  }
  return -1;
}

// Dvojité uvozovky všech druhů; jednoduché ne, ty bývají apostrofy.
const QUOTED = /["“„”«»]([^"“„”«»]+)["“„”«»]/g;
// Jak daleko (podíl délky textu) smějí být uvozovky překladu od místa odkazu v originálu.
const QUOTE_DRIFT = 0.15;

/**
 * Název (webinář, studie) přeloží model mimo kontext jinak než v odstavci a v odstavci ho často dá do uvozovek.
 * Odkazu pak odpovídají nejbližší volné uvozovky překladu na podobném poměrném místě jako odkaz v originálu.
 */
function quotedRange(text: string, anchor: string, source: string, taken: AnchorRange[]): AnchorRange | null {
  const at = source.toLowerCase().indexOf(anchor.toLowerCase());
  if (at < 0) return null;
  const position = (at + anchor.length / 2) / source.length;
  let best: AnchorRange | null = null;
  let distance = QUOTE_DRIFT;
  for (const q of text.matchAll(QUOTED)) {
    const lead = q[1].search(/\S/);
    const inner = q[1].trimEnd().replace(/[^\p{L}\p{N}]+$/u, '');
    const range = { start: q.index + 1 + lead, end: q.index + 1 + inner.length };
    const d = Math.abs((range.start + range.end) / 2 / text.length - position);
    if (range.end > range.start && d < distance && !taken.some((t) => t.start < range.end && range.start < t.end)) {
      best = range;
      distance = d;
    }
  }
  return best;
}

/**
 * Místa odkazů v přeloženém textu jako rozsahy znaků (bez interpunkce na krajích); null, když se odkaz nenašel.
 * Hledá přeložený text odkazu, pak jeho kmeny (skloňování), původní text (jména, adresy), nakonec podle uvozovek.
 * Odkaz přes celý zdroj pokryje celý překlad. Odkazy se hledají postupně, stejný text dvakrát najde dvě místa.
 */
export function findAnchors(text: string, links: { source: string; target?: string }[], source: string): (AnchorRange | null)[] {
  const matches = [...text.matchAll(/\S+/g)];
  const tokens = matches.map((m) => bare(m[0]));
  const word = /[\p{L}\p{N}]/u;
  const range = (i: number, n: number): AnchorRange | null => {
    let start = matches[i].index;
    let end = matches[i + n - 1].index + matches[i + n - 1][0].length;
    while (start < end && !word.test(text[start])) start++;
    while (end > start && !word.test(text[end - 1])) end--;
    return end > start ? { start, end } : null;
  };
  const whole = words(source).join(' ');
  let from = 0;
  const found: (AnchorRange | null)[] = links.map((link) => {
    if (!matches.length) return null;
    if (words(link.source).join(' ') === whole) return range(0, matches.length);
    const tries: [string[], boolean][] = [
      [tokenize(link.target ?? ''), false],
      [tokenize(link.target ?? ''), true],
      [tokenize(link.source), false],
    ];
    for (const start of from ? [from, 0] : [0]) {
      for (const [needle, stems] of tries) {
        if (!needle.length) continue;
        const match = stems ? (t: string, w: string) => t.startsWith(looseStem(w)) : (t: string, w: string) => t === w;
        for (const size of stems ? [needle.length, needle.length + 1] : [needle.length]) {
          const i = findWindow(tokens, needle, size, start, match);
          if (i >= 0) {
            from = i + size;
            return range(i, size);
          }
        }
      }
    }
    return null;
  });
  // Uvozovky až nakonec, aby nezabraly místo odkazu nalezeného podle textu.
  return found.map((r, i) => {
    if (r) return r;
    const taken = found.filter((f): f is AnchorRange => !!f);
    return (found[i] = quotedRange(text, links[i].source, source, taken));
  });
}

// Fráze, kterými model místo překladu odpoví omluvou, dotazem nebo popisem (česky i anglicky).
const REFUSAL_PHRASES = [
  /omlouv[aá]m se/i,
  /nerozum[ií]m/i,
  /nemohu (to|jej|je|ho|ji|tento|tyto)?\s*přeložit/i,
  /mohl(a)? byste/i,
  /můžete mi poskytnout/i,
  /poskytněte/i,
  /zde následuje/i,
  /nelze přesně přeložit/i,
  /i['’]?m sorry/i,
  /i apologi[sz]e/i,
  /i (cannot|can['’]?t|am unable to|do not understand|don['’]?t understand)/i,
  /please provide/i,
  /could you (please )?(provide|clarify|repeat|send)/i,
];

/** Model místo překladu odpověděl omluvou nebo dotazem; jeho výstup se nesmí použít. */
export function isRefusal(source: string, output: string): boolean {
  // Aspoň dvě různé fráze: jedna („Mohl byste…“) bývá i v řádném překladu otázky.
  const phrases = REFUSAL_PHRASES.filter((p) => p.test(output)).length;
  // Zdroj, který sám obsahuje takovou frázi („I'm sorry“), se překládá správně.
  if (phrases >= 2 && !REFUSAL_PHRASES.some((p) => p.test(source))) return true;
  return source.length < 40 && output.length > 60 && output.length > source.length * 3 && /\?|přeložit|translate/i.test(output);
}
