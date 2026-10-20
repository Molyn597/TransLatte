import { copyFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Job, JobOptions, Mode, Rates } from '../shared/types';
import { unloadAll } from './lmstudio';
import { runJob, type Measured } from './pipeline';
import type { Store } from './store';

export const SUPPORTED = ['.pdf', '.docx', '.txt', '.md'];

export interface QueueEvents {
  update(job: Job): void;
  finished(job: Job): void;
  idle(): void;
}

// Nové měření se do průměru promítne z 30 %, jedna netypická úloha odhad nerozhodí.
function blend(rates: Rates, m: Measured): Rates {
  const mix = (old: number, value?: number) => (value && Number.isFinite(value) ? old * 0.7 + value * 0.3 : old);
  return {
    ocrPerPage: mix(rates.ocrPerPage, m.ocrPerPage),
    translatePerKChar: mix(rates.translatePerKChar, m.translatePerKChar),
    fixPerSegment: mix(rates.fixPerSegment, m.fixPerSegment),
  };
}

export class Queue {
  private waiting: string[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private lastSent = 0;

  constructor(
    private store: Store,
    private events: QueueEvents,
  ) {}

  get busy() {
    return this.running !== null || this.waiting.length > 0;
  }

  /** Úlohy přerušené pádem nebo zavřením aplikace se po startu označí jako zrušené. */
  async recover() {
    for (const job of await this.store.jobs()) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'cancelled';
        job.error = 'Aplikace byla během překladu ukončena.';
        job.progress = undefined;
        await this.store.saveJob(job);
      }
    }
  }

  async add(file: string, options: JobOptions) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED.includes(ext)) throw new Error(`Formát ${ext || 'bez přípony'} není podporovaný.`);
    const job: Job = {
      id: randomUUID(),
      name: path.basename(file, path.extname(file)),
      ext,
      ...options,
      pageRange: options.pageRange?.trim() || undefined,
      status: 'queued',
      createdAt: Date.now(),
      warnings: 0,
    };
    await mkdir(this.store.jobDir(job.id), { recursive: true });
    await copyFile(file, this.store.inputPath(job));
    await this.enqueue(job);
  }

  async retry(id: string, mode: Mode) {
    const old = await this.store.job(id);
    if (!old) return;
    const job: Job = {
      ...old,
      id: randomUUID(),
      mode,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      progress: undefined,
      output: undefined,
      warnings: 0,
      context: undefined,
      notes: undefined,
    };
    await mkdir(this.store.jobDir(job.id), { recursive: true });
    await copyFile(this.store.inputPath(old), this.store.inputPath(job));
    await this.enqueue(job);
  }

  private async enqueue(job: Job) {
    await this.store.saveJob(job);
    this.events.update(job);
    this.waiting.push(job.id);
    void this.pump();
  }

  async cancel(id: string) {
    if (this.running?.id === id) {
      this.running.abort.abort();
      return;
    }
    if (!this.waiting.includes(id)) return;
    this.waiting = this.waiting.filter((w) => w !== id);
    const job = await this.store.job(id);
    if (job) {
      job.status = 'cancelled';
      await this.store.saveJob(job);
      this.events.update(job);
    }
  }

  async remove(id: string) {
    await this.cancel(id);
    // Běžící úloha si složku po zrušení ještě zapíše; smazat až po doběhnutí.
    while (this.running?.id === id) await new Promise((r) => setTimeout(r, 100));
    await this.store.deleteJob(id);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.waiting.shift();
    if (!id) {
      const settings = await this.store.settings();
      if (settings.unloadWhenIdle) await unloadAll();
      this.events.idle();
      return;
    }
    const job = await this.store.job(id);
    if (!job) return this.pump();
    const abort = new AbortController();
    this.running = { id, abort };
    job.status = 'running';
    job.startedAt = Date.now();
    await this.store.saveJob(job);
    this.events.update(job);

    job.timings = {};
    let stageStart = Date.now();
    const closeStage = () => {
      const stage = job.progress?.stage;
      if (stage) job.timings![stage] = (job.timings![stage] ?? 0) + (Date.now() - stageStart) / 1000;
      stageStart = Date.now();
    };
    try {
      const settings = await this.store.settings();
      const measured = await runJob({
        job,
        settings,
        glossary: await this.store.glossary(),
        store: this.store,
        signal: abort.signal,
        progress: (p) => {
          if (p.stage !== job.progress?.stage) closeStage();
          job.progress = p;
          // Průběh posílat nejvýš 4× za sekundu, ať se UI nezahltí.
          if (Date.now() - this.lastSent > 250) {
            this.lastSent = Date.now();
            this.events.update(job);
          }
        },
      });
      job.status = 'done';
      const fresh = await this.store.settings();
      await this.store.saveSettings({ ...fresh, rates: blend(fresh.rates, measured) });
    } catch (e) {
      const err = e as Error;
      if (abort.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = err.message || String(err);
      }
    } finally {
      closeStage();
      job.finishedAt = Date.now();
      job.progress = undefined;
      await this.store.saveJob(job);
      this.running = null;
      this.events.update(job);
      this.events.finished(job);
      void this.pump();
    }
  }
}
