// Před kterými hláskami dostává neslabičná předložka vokál (navíc před zájmeny mnou/mne/mně; „v mnoha“ zůstává).
const VOCALIZE: Record<string, string> = { s: 'szšž', z: 'szšž', k: 'kg', v: 'vf' };

// Předložka jako samostatné slovo, jedna mezera a slovo jen z písmen (ne zkratka, číslo ani kód typu „v2“).
const PREPOSITION = /(?<=^|[\s„("\[])([szkv])([  ])(\p{L}+)(?![\p{L}\p{N}_])/giu;

/** „s zaměstnanci“ → „se zaměstnanci“, „k kolegům“ → „ke kolegům“, „v Vídni“ → „ve Vídni“. */
export function fixPrepositions(text: string): string {
  return text.replace(PREPOSITION, (match, prep: string, space: string, word: string) => {
    const lower = word.toLowerCase();
    if (!VOCALIZE[prep.toLowerCase()].includes(lower[0]) && !/^mn(ou|e|ě)$/.test(lower)) return match;
    const vowel = prep === prep.toUpperCase() && word.length > 1 && word === word.toUpperCase() ? 'E' : 'e';
    return prep + vowel + space + word;
  });
}

// Častá anglická slova; vynechána ta, která jsou zároveň česká nebo dvojznačná (to, on, a, i, no, ten, list, most, by, do, my, her, had, show…).
const ENGLISH = new Set(
  `the and of with that for is are was were this these those from have has not but which who whom whose what
  when where why how will would should could can cannot must might may shall their they them we our you your about
  into onto than also only very such each other more there been being because while after before between through
  without within however therefore its his she him here then all any some many much few both either neither own same
  just even still already always never often again well over under above below upon among against during until
  since although though whether unless thus hence moreover furthermore nevertheless whereas does did doing having
  make made makes use used using first new people year years study studies research results found based
  important different following example less least further out off up down if or be an at yes`
    .split(/\s+/)
    .filter(Boolean),
);

// Text v uvozovkách a závorkách bývá záměrně ponechaný v originále (názvy, citace).
const QUOTED = [/„[^“”"]*[“”"]/g, /“[^”]*”/g, /‚[^‘’']*[‘’']/g, /"[^"\n]*"/g, /(?<!\p{L})'[^'\n]*'(?!\p{L})/gu, /\[[^\]]*\]/g];

function stripQuoted(text: string) {
  let out = text;
  for (const re of QUOTED) out = out.replace(re, ' ');
  for (let prev = ''; prev !== out; ) [prev, out] = [out, out.replace(/\([^()]*\)/g, ' ')];
  return out;
}

/** Anglická slova, která zůstala v českém překladu (unikátní, malými písmeny). */
export function untranslatedWords(translation: string): string[] {
  const found = new Set<string>();
  for (const [w] of stripQuoted(translation).matchAll(/\p{L}+/gu)) {
    const lower = w.toLowerCase();
    if (ENGLISH.has(lower)) found.add(lower);
  }
  return [...found];
}
