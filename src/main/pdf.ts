import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { PdfOpenResult, PdfRenderResult, PdfTask, PdfTextResult } from '../shared/pdf';

let host: BrowserWindow | undefined;
let ready: Promise<void> | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

ipcMain.on('pdf-result', (_e, id: number, result: unknown, error?: string) => {
  const p = pending.get(id);
  pending.delete(id);
  if (!p) return;
  if (error) p.reject(new Error(`PDF: ${error}`));
  else p.resolve(result);
});

function ensureHost() {
  if (host && !host.isDestroyed()) return ready!;
  host = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'pdf-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  host.webContents.on('render-process-gone', () => {
    for (const p of pending.values()) p.reject(new Error('Okno pro PDF spadlo.'));
    pending.clear();
    host = undefined;
  });
  ready = host.loadFile(path.join(__dirname, 'pdf-host.html'));
  return ready;
}

async function request<T>(task: PdfTask): Promise<T> {
  await ensureHost();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    host!.webContents.send('pdf-task', id, task);
  });
}

export const openPdf = (docId: string, data: Uint8Array) => request<PdfOpenResult>({ op: 'open', docId, data });
export const pageText = (docId: string, page: number) => request<PdfTextResult>({ op: 'text', docId, page });
export const renderPage = (docId: string, page: number, scale: number, crop?: [number, number, number, number]) =>
  request<PdfRenderResult>({ op: 'render', docId, page, scale, crop });
export const closePdf = (docId: string) => request<null>({ op: 'close', docId }).catch(() => null);
