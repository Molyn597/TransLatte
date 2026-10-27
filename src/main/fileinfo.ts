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

/** Informace pro odhad ceny; soubor, který nejde přečíst, se vynechá (chybu ohlásí až přidání úlohy). */
export async function fileInfo(paths: string[]): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (const file of paths) {
    const i = await info(file).catch(() => undefined);
    if (i) out.push(i);
  }
  return out;
}
