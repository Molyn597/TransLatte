import type { Segment } from '../shared/types';
import { finalText } from './segments';

/** Úsek dokumentu, ze kterého může chat odpovídat; číslo citace = id segmentu. */
export interface Passage {
  id: number;
  page?: number;
  heading: boolean;
  /** Text pro model: překlad, u nepřeloženého segmentu originál. */
  text: string;
  /** Text pro hledání: originál i překlad. */
  search: string;
}

// Parametry BM25: běžné hodnoty z literatury.
const K1 = 1.2;
const B = 0.75;
// Ořez na prvních 5 písmen bez diakritiky: jednoduchý stemmer, pro češtinu překvapivě účinný
// („zákona“, „zákonem“ → „zakon“) a pro angličtinu stačí.
const STEM = 5;

const STOP = new Set(
  ('the and for are was were with that this from have has had not but its their they which what when where who how why ' +
    'does into also than then there these those such been being can could would should about between ' +
    'jak jaky jaka jake kde kdo kdy proc ktery ktera ktere ten tento tato toto tak take jsou byla bylo byly jako pro pri ' +
    'nebo ale aby jeho jeji jejich jsem jsme muze podle rika')
    .split(' '),
);

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Slova jako kmeny; čísla (paragrafy, roky) zůstávají celá. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of fold(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\d+$/.test(w)) out.push(w);
    else if (w.length >= 3 && !STOP.has(w)) out.push(w.slice(0, STEM));
  }
  return out;
}

export function passages(segments: Segment[]): Passage[] {
  return segments
    .filter((s) => !s.layoutOnly && !s.figure && !s.inSnapshot && s.source.trim())
    .map((s) => {
      const translated = !s.skipped && s.translation !== undefined;
      const text = translated ? finalText(s) : s.source;
      return { id: s.id, page: s.page, heading: s.kind === 'heading', text, search: translated ? `${s.source}\n${text}` : s.source };
    });
}

/** BM25 nad celým dokumentem; index se staví při každém dotazu, na jeden dokument je to okamžité. */
export function search(items: Passage[], query: string, limit: number): Passage[] {
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  const docs = items.map((p) => {
    const tf = new Map<string, number>();
    const words = terms(p.search);
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { p, tf, len: words.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  const idf = new Map(
    q.map((w) => {
      const df = docs.filter((d) => d.tf.has(w)).length;
      return [w, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
    }),
  );
  return docs
    .map((d) => ({
      p: d.p,
      score: q.reduce((s, w) => {
        const f = d.tf.get(w) ?? 0;
        return f ? s + idf.get(w)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg))) : s;
      }, 0),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.p);
}

/**
 * Nejlepší zásahy do limitu znaků, každý s nejbližším předchozím nadpisem (model ví, z jaké části je),
 * seřazené v pořadí dokumentu.
 */
export function selectPassages(items: Passage[], hits: Passage[], maxChars: number): Passage[] {
  const index = new Map(items.map((p, i) => [p.id, i]));
  const chosen = new Map<number, Passage>();
  let chars = 0;
  const add = (p: Passage) => {
    if (chosen.has(p.id)) return true;
    if (chars + p.text.length > maxChars) return false;
    chosen.set(p.id, p);
    chars += p.text.length;
    return true;
  };
  for (const hit of hits) {
    if (!add(hit)) break;
    for (let i = index.get(hit.id)! - 1; i >= 0; i--) {
      if (items[i].heading) {
        add(items[i]);
        break;
      }
    }
  }
  return [...chosen.values()].sort((a, b) => index.get(a.id)! - index.get(b.id)!);
}

export const totalChars = (items: Passage[]) => items.reduce((s, p) => s + p.text.length, 0);

export const formatPassages = (items: Passage[]) =>
  items.map((p) => `[${p.id}]${p.page ? ` (p. ${p.page})` : ''} ${p.heading ? '## ' : ''}${p.text.replace(/\s+/g, ' ').trim()}`).join('\n\n');

/**
 * Citace z odpovědi: ponechá jen čísla poskytnutých úseků („[3, 5]“ → „[3][5]“), vymyšlené zahodí.
 * Vrací upravený text a citované id v pořadí prvního výskytu.
 */
export function cleanCitations(answer: string, allowed: Set<number>): { text: string; sources: number[] } {
  const sources: number[] = [];
  const text = answer
    .replace(/\s*\[(\d+(?:\s*[,;–-]\s*\d+)*)\]/g, (_m, list: string) => {
      const ids = list
        .split(/\s*[,;–-]\s*/)
        .map(Number)
        .filter((n) => allowed.has(n));
      for (const id of ids) if (!sources.includes(id)) sources.push(id);
      return ids.length ? ` ${ids.map((id) => `[${id}]`).join('')}` : '';
    })
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
  return { text, sources };
}
