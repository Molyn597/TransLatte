import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spellWorkerPath } from '../src/main/spell-client';
import { createChecker, ensureDictionary, misspelledWords, spellBatch, unpackTgz } from '../src/main/spell';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/spell', name));
const checker = createChecker(fixture('mini.aff'), fixture('mini.dic'));

// Ruční ustar hlavička: jméno, velikost a typ v osmičkové soustavě, kontrolní součet přes celou hlavičku.
function tarEntry(name: string, content: string, type = '0', prefix = '') {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345);
  header.fill(' ', 148, 156);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const tgz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

describe('unpackTgz', () => {
  it('rozbalí běžné soubory včetně prefixu ustar a přeskočí složky', () => {
    const big = 'x'.repeat(1300);
    const files = unpackTgz(
      tgz(
        tarEntry('package/', '', '5'),
        tarEntry('package/index.aff', 'SET UTF-8\n'),
        tarEntry('index.dic', big, '0', 'package'),
        tarEntry('package/readme.md', 'ahoj'),
      ),
    );
    expect([...files.keys()]).toEqual(['package/index.aff', 'package/index.dic', 'package/readme.md']);
    expect(files.get('package/index.aff')!.toString()).toBe('SET UTF-8\n');
    expect(files.get('package/index.dic')!.toString()).toBe(big);
  });

  it('useknutý archiv odmítne', () => {
    const entry = tarEntry('package/index.dic', 'y'.repeat(2000));
    expect(() => unpackTgz(gzipSync(entry.subarray(0, 1024)))).toThrow('poškozený');
  });
});

describe('ensureDictionary', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'translatte-spell-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('existující slovník načte z disku bez stahování', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await mkdir(join(dir, 'cs'));
    await writeFile(join(dir, 'cs/index.aff'), 'aff');
    await writeFile(join(dir, 'cs/index.dic'), 'dic');
    const { aff, dic } = await ensureDictionary(dir);
    expect([aff.toString(), dic.toString()]).toEqual(['aff', 'dic']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('při neshodě kontrolního součtu nic neuloží', async () => {
    const archive = tgz(tarEntry('package/index.aff', 'aff'), tarEntry('package/index.dic', 'dic'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(archive)));
    await expect(ensureDictionary(dir)).rejects.toThrow('kontrolnímu součtu');
    expect(await readdir(dir)).toEqual([]);
  });

  it('chyba HTTP má českou hlášku', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(ensureDictionary(dir)).rejects.toThrow('HTTP 503');
  });
});

describe('createChecker', () => {
  it('napojení na nspell: slova i tvary z přípon', () => {
    expect(checker.correct('kolega')).toBe(true);
    expect(checker.correct('kolegům')).toBe(true);
    expect(checker.correct('kolegové')).toBe(true);
    expect(checker.correct('kolegaům')).toBe(false);
  });
});

describe('misspelledWords', () => {
  const source = 'We decided about promotions. We shared our experience with employees at Gallup.';

  it('najde překlepy, jméno z originálu nenahlásí', () => {
    const translation = 'Rozhodli jsme se o povýbeních. Sdělidli jsme svou zkušenost se zaměstnanci ve společnosti Gallup.';
    expect(misspelledWords(checker, translation, source)).toEqual(['povýbeních', 'Sdělidli']);
  });

  it('přeskočí čísla, krátká slova, zkratky, URL a e-maily', () => {
    const translation = 'Jsme ve verzi abc12 xy NATO ABCDE https://priklad.cz/stranka nebo jmeno@priklad.cz';
    expect(misspelledWords(checker, translation, '')).toEqual(['verzi', 'nebo']);
  });

  it('přeskočí slova z originálu bez ohledu na velikost písmen a vlastní jména uprostřed věty', () => {
    expect(misspelledWords(checker, 'Jsme se GALLUP a Novákem.', 'gallup')).toEqual([]);
  });

  it('velké písmeno po tečce, novém řádku nebo uvozovkách je začátek věty', () => {
    const translation = 'Jsme. Chiba jsme.\nPřeklep jsme. „Omyl“ a „Jinde“ https://priklad.cz/a. Chyba';
    expect(misspelledWords(checker, translation, '')).toEqual(['Chiba', 'Překlep', 'Omyl', 'Chyba']);
  });

  it('slova se spojovníkem kontroluje po částech, každé slovo nahlásí jen jednou', () => {
    expect(misspelledWords(checker, 'česko-slovenský česko-slovesnký spolupráce slovesnký Slovesnký', '')).toEqual([
      'slovesnký',
    ]);
  });
});

describe('spellBatch', () => {
  it('vrátí chybná slova pro každou položku dávky ve stejném pořadí', () => {
    expect(
      spellBatch(checker, [
        { translation: 'Sdělidli jsme kolegům.', source: '' },
        { translation: 'Jsme kolegové.', source: '' },
        { translation: 'Gallup povýbeních', source: 'Gallup' },
      ]),
    ).toEqual([['Sdělidli'], [], ['povýbeních']]);
  });
});

describe('spellWorkerPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'translatte-asar-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('v zabalené aplikaci vede do app.asar.unpacked, jinak zůstane cesta beze změny', async () => {
    const packed = join(dir, 'app.asar', 'dist');
    expect(spellWorkerPath(packed)).toBe(join(packed, 'spell-worker.js'));
    await mkdir(join(dir, 'app.asar.unpacked', 'dist'), { recursive: true });
    await writeFile(join(dir, 'app.asar.unpacked', 'dist', 'spell-worker.js'), '');
    expect(spellWorkerPath(packed)).toBe(join(dir, 'app.asar.unpacked', 'dist', 'spell-worker.js'));
    expect(spellWorkerPath(join(dir, 'dist'))).toBe(join(dir, 'dist', 'spell-worker.js'));
  });
});
