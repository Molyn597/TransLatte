import { hyphenateSync as hyphenCs } from 'hyphen/cs';
import { hyphenateSync as hyphenEn } from 'hyphen/en-us';

const SOFT = '­';
const MIN_WORD = 6;
const MIN_HEAD = 2;
const MIN_TAIL = 3;

const engines: Record<string, (word: string, options: { hyphenChar: string }) => string> = { cs: hyphenCs, en: hyphenEn };
const cache = new Map<string, string[]>();

// Slova, která se nikdy nedělí: čísla, adresy, zkratky velkými písmeny, apostrofy.
function isProtected(word: string): boolean {
  return /\d|[/@'’]|www\.|:\/\/|\p{Lu}{2}/u.test(word);
}

// Pozice řezů (v počtu znaků) respektující minimum na začátku a na konci slova.
function cutPositions(core: string, lang: string): number[] {
  const marked = engines[lang](core, { hyphenChar: SOFT });
  const cuts: number[] = [];
  let pos = 0;
  for (const piece of marked.split(SOFT).slice(0, -1)) {
    pos += piece.length;
    if (pos >= MIN_HEAD && core.length - pos >= MIN_TAIL) cuts.push(pos);
  }
  return cuts;
}

function split(word: string, lang: string): string[] {
  if (!engines[lang] || isProtected(word)) return [word];
  const [, head, core, tail] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(word)!;

  // Pevný spojovník: lámat se smí jen za ním, uvnitř částí se nedělí.
  if (core.includes('-')) {
    const segments = core.split('-');
    if (segments.some((s) => !/^\p{L}+$/u.test(s))) return [word];
    return segments.map((s, i) => (i === 0 ? head : '') + s + (i < segments.length - 1 ? '-' : tail));
  }

  if (core.length < MIN_WORD || !/^\p{L}+$/u.test(core)) return [word];
  const bounds = [0, ...cutPositions(core, lang), core.length];
  return bounds.slice(1).map((end, i) => {
    const text = core.slice(bounds[i], end);
    return (i === 0 ? head : '') + text + (i === bounds.length - 2 ? tail : '');
  });
}

// Části slova, mezi kterými se smí zalomit; jejich spojením vznikne přesně původní slovo.
export function hyphenParts(word: string, lang: string): string[] {
  const key = `${lang}\0${word}`;
  let parts = cache.get(key);
  if (!parts) {
    parts = split(word, lang);
    cache.set(key, parts);
  }
  return parts;
}
