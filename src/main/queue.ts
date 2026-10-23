import { copyFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { t } from '../shared/i18n';
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
  // Dotazy na model (překlad oblasti) počkají na běžící úlohu, ale předběhnou čekající.
  private urgent: (() => Promise<void>)[] = [];
  private working = false;
  private lastSent = 0;

  constructor(
    private store: Store,
    private events: QueueEvents,
  ) {}

  get busy() {
    return this.running !== null || this.working || this.waiting.length > 0;
  }

  /** Spustí práci s modelem mezi úlohami, aby nepřehodila model běžící úloze. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.urgent.push(() => fn().then(resolve, reject));
      void this.pump();
    });
  }

  /** Úlohy přerušené pádem nebo zavřením aplikace se po startu označí jako zrušené. */
  async recover() {
    for (const job of await this.store.jobs()) {
      if (job.resume) {
        job.status = job.output ? 'done' : 'picking';
        job.resume = undefined;
        job.progress = undefined;
        await this.store.saveJob(job);
      } else if (job.status === 'running' || job.status === 'queued') {
        job.status = 'cancelled';
        job.error = t('queue.interrupted');
        job.progress = undefined;
        await this.store.saveJob(job);
      }
    }
  }

  async add(file: string, options: JobOptions) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED.includes(ext)) throw new Error(t('queue.unsupported', { ext: ext || t('queue.noExtension') }));
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
      resume: undefined,
      output: undefined,
      outputPdf: undefined,
      warnings: 0,
      context: undefined,
      notes: undefined,
    };
    await mkdir(this.store.jobDir(job.id), { recursive: true });
    await copyFile(this.store.inputPath(old), this.store.inputPath(job));
    await this.enqueue(job);
  }

  /** Úloha čekající na výběr nebo hotová přeloží vybrané segmenty; ostatní nepřeložené přeskočí. */
  async translateSegments(id: string, ids: number[]) {
    const job = await this.store.job(id);
    if (!job || (job.status !== 'picking' && job.status !== 'done')) return;
    const chosen = new Set(ids);
    const segments = await this.store.segments(id);
    for (const s of segments) {
      if (s.translation !== undefined) continue;
      if (chosen.has(s.id)) delete s.skipped;
      else s.skipped = true;
    }
    await this.store.saveSegments(id, segments);
    job.resume = true;
    job.status = 'queued';
    job.error = undefined;
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
      job.status = job.resume ? (job.output ? 'done' : 'picking') : 'cancelled';
      job.resume = undefined;
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
    if (this.running || this.working) return;
    const task = this.urgent.shift();
    if (task) {
      this.working = true;
      await task();
      this.working = false;
      // Po dotazu se model neuvolňuje, uživatel se nejspíš bude ptát dál.
      if (this.urgent.length || this.waiting.length) return this.pump();
      this.events.idle();
      return;
    }
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

    if (!job.resume || !job.timings) job.timings = {};
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
      job.status = measured.paused ? 'picking' : 'done';
      const fresh = await this.store.settings();
      await this.store.saveSettings({ ...fresh, rates: blend(fresh.rates, measured) });
    } catch (e) {
      const err = e as Error;
      if (job.resume) {
        // Nepovedené nebo zrušené překládání dalších odstavců nechá úlohu, jak byla.
        job.status = job.output ? 'done' : 'picking';
        if (!abort.signal.aborted) (job.notes ??= []).push(err.message || String(err));
      } else if (abort.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = err.message || String(err);
      }
    } finally {
      closeStage();
      job.finishedAt = Date.now();
      job.progress = undefined;
      job.resume = undefined;
      await this.store.saveJob(job);
      this.running = null;
      this.events.update(job);
      this.events.finished(job);
      void this.pump();
    }
  }
}
