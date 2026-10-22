import { existsSync } from 'node:fs';
import { t } from '../shared/i18n';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SpellItem } from './spell';

/** Worker v zabalené aplikaci leží v app.asar.unpacked (z app.asar ho worker_threads nespustí). */
export function spellWorkerPath(dir: string) {
  const file = path.join(dir, 'spell-worker.js');
  const unpacked = file.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
}

export class SpellWorker {
  private worker: Worker;
  private pending = new Map<number, { resolve: (r: string[][]) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private failure: Error | undefined;

  constructor(file: string, dictionary: { aff: Buffer; dic: Buffer }) {
    this.worker = new Worker(file, { workerData: dictionary });
    this.worker.on('message', ({ id, result, error }: { id: number; result?: string[][]; error?: string }) => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result!);
    });
    this.worker.on('error', (err) => this.fail(err as Error));
    this.worker.on('exit', (code) => this.fail(new Error(t('spell.exited', { code: code ?? '?' }))));
  }

  private fail(err: Error) {
    this.failure ??= err;
    for (const p of this.pending.values()) p.reject(this.failure);
    this.pending.clear();
  }

  check(items: SpellItem[]): Promise<string[][]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, items });
    });
  }

  terminate() {
    return this.worker.terminate();
  }
}
