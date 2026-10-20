import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import nspell from 'nspell';

// Slovník (GPL-2.0) se nebalí do aplikace, stáhne se až při prvním použití.
const DICTIONARY_URL = 'https://registry.npmjs.org/dictionary-cs/-/dictionary-cs-4.0.0.tgz';
const DICTIONARY_SHA512 = 'foYC1H71sxEx2QwppL4liEFAD+O5wlyJeZkTFqwz7ux85dI8kQFc8sDmWeObPEXsTtksiuwv+OOdfS2mFY1YVA==';

const octal = (block: Buffer, start: number, length: number) =>
  parseInt(block.subarray(start, start + length).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
const field = (block: Buffer, start: number, length: number) =>
  block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');

/** Soubory z .tgz (gzip + ustar). Vrací jen běžné soubory, cesty jsou včetně prefixu ustar. */
export function unpackTgz(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    const prefix = field(header, 257, 6).startsWith('ustar') ? field(header, 345, 155) : '';
    const name = (prefix ? `${prefix}/` : '') + field(header, 0, 100);
    const start = offset + 512;
    if (start + size > tar.length) throw new Error('Archiv se slovníkem je poškozený.');
    if (type === '0' || type === '\0') files.set(name, tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function writeAtomic(path: string, data: Buffer) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Český Hunspell slovník z `${dir}/cs`; když chybí, stáhne ho z npm registry a ověří integritu. */
export async function ensureDictionary(dir: string, signal?: AbortSignal): Promise<{ aff: Buffer; dic: Buffer }> {
  const target = join(dir, 'cs');
  const affPath = join(target, 'index.aff');
  const dicPath = join(target, 'index.dic');
  try {
    return { aff: await readFile(affPath), dic: await readFile(dicPath) };
  } catch {
    // Slovník ještě není stažený (nebo je neúplný).
  }

  let response: Response;
  try {
    response = await fetch(DICTIONARY_URL, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Český slovník se nepodařilo stáhnout: ${(err as Error).message}`);
  }
  if (!response.ok) throw new Error(`Český slovník se nepodařilo stáhnout (HTTP ${response.status}).`);
  const tgz = Buffer.from(await response.arrayBuffer());
  if (createHash('sha512').update(tgz).digest('base64') !== DICTIONARY_SHA512) {
    throw new Error('Stažený český slovník neodpovídá očekávanému kontrolnímu součtu, nebyl uložen.');
  }

  const files = unpackTgz(tgz);
  const aff = files.get('package/index.aff');
  const dic = files.get('package/index.dic');
  if (!aff || !dic) throw new Error('V archivu českého slovníku chybí soubory index.aff a index.dic.');
  await mkdir(target, { recursive: true });
  // .dic až nakonec: bez něj se při dalším spuštění stahuje znovu.
  await writeAtomic(affPath, aff);
  await writeAtomic(dicPath, dic);
  return { aff, dic };
}

export function createChecker(aff: Buffer, dic: Buffer) {
  return nspell(aff, dic);
}

export type SpellChecker = ReturnType<typeof createChecker>;

const URLS = /\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/giu;
const WORD = /\p{L}[\p{L}\p{N}\p{M}]*(?:[-\u2010\u2011][\p{L}\p{N}\p{M}]+)*|\p{N}[\p{L}\p{N}\p{M}]*/gu;
// URL se nahradí stejně dlouhými mezerami, aby indexy slov seděly s původním textem.
const words = (text: string) => [...text.replace(URLS, (m) => ' '.repeat(m.length)).matchAll(WORD)];

// Začátek věty: před slovem (kromě mezer a otevíracích znaků) je začátek textu, nový řádek nebo .!?…
function sentenceStart(text: string, index: number) {
  for (let i = index - 1; i >= 0; i--) {
    if (/[.!?…\n]/.test(text[i])) return true;
    if (!/[\s„“"'‚(\[–—-]/.test(text[i])) return false;
  }
  return true;
}

/** Unikátní chybná slova v českém překladu (jména a termíny z originálu se přeskakují). */
export function misspelledWords(checker: SpellChecker, translation: string, source: string): string[] {
  const known = new Set(words(source).flatMap(([w]) => [w.toLowerCase(), ...w.toLowerCase().split(/[-\u2010\u2011]/)]));
  const found = new Map<string, string>();
  for (const match of words(translation)) {
    const atStart = sentenceStart(translation, match.index);
    match[0].split(/[-\u2010\u2011]/).forEach((part, i) => {
      const lower = part.toLowerCase();
      if (/\p{N}/u.test(part) || part.length < 3) return;
      if (part.length <= 5 && part === part.toUpperCase()) return;
      if (known.has(lower) || found.has(lower)) return;
      if (part[0] !== part[0].toLowerCase() && !(atStart && i === 0)) return;
      if (!checker.correct(part)) found.set(lower, part);
    });
  }
  return [...found.values()];
}

export interface SpellItem {
  translation: string;
  source: string;
}

/** Dávka pro spell worker: chybná slova pro každou položku. */
export const spellBatch = (checker: SpellChecker, items: SpellItem[]) =>
  items.map((i) => misspelledWords(checker, i.translation, i.source));
