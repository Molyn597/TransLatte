import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileInfo } from '../shared/types';
import { closePdf, openPdf } from './pdf';

let counter = 0;

async function info(file: string): Promise<FileInfo | undefined> {
  switch (path.extname(file).toLowerCase()) {
    case '.pdf': {
      const docId = `info-${counter++}`;
      const { pages } = await openPdf(docId, new Uint8Array(await readFile(file)));
      await closePdf(docId);
      return { kind: 'pdf', pages };
    }
    case '.docx':
      return { kind: 'docx' };
    case '.txt':
    case '.md':
      return { kind: 'text', chars: (await readFile(file, 'utf8')).length };
  }
}

/** Informace pro odhad ceny; soubor, který nejde přečíst, je null (chybu ohlásí až přidání úlohy). */
export async function fileInfo(paths: string[]): Promise<(FileInfo | null)[]> {
  const out: (FileInfo | null)[] = [];
  for (const file of paths) out.push((await info(file).catch(() => undefined)) ?? null);
  return out;
}
