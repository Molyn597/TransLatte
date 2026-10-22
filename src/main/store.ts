import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { GlossaryEntry, Job, Segment, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  uiLang: 'system',
  apiUrl: 'http://localhost:1234',
  models: { ocr: 'unlimited-ocr', translate: 'translategemma-12b-it', polish: 'google/gemma-4-12b-qat' },
  mode: 'fast',
  sourceLang: 'auto',
  targetLang: 'cs',
  notify: true,
  unloadWhenIdle: true,
  theme: 'system',
  layoutPdf: true,
  rates: { ocrPerPage: 7, translatePerKChar: 25, fixPerSegment: 8 },
};

/** Úložiště pod userData: settings.json, glossary.json a jobs/<id>/{job.json, segments.json, vstup, výstup}. */
export class Store {
  constructor(readonly root: string) {}

  jobDir = (id: string) => path.join(this.root, 'jobs', id);

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  // Zápis přes dočasný soubor, aby pád uprostřed zápisu nezničil historii.
  private async writeJson(file: string, data: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 1));
    await rename(tmp, file);
  }

  async settings(): Promise<Settings> {
    const saved = await this.readJson<Partial<Settings>>(path.join(this.root, 'settings.json'), {});
    // Starší nastavení mají místo fixPerSegment polishPerKChar; zahodí se.
    const { ocrPerPage, translatePerKChar, fixPerSegment } = { ...DEFAULT_SETTINGS.rates, ...saved.rates };
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      models: { ...DEFAULT_SETTINGS.models, ...saved.models },
      rates: { ocrPerPage, translatePerKChar, fixPerSegment },
    };
  }

  saveSettings = (settings: Settings) => this.writeJson(path.join(this.root, 'settings.json'), settings);

  glossary = () => this.readJson<GlossaryEntry[]>(path.join(this.root, 'glossary.json'), []);

  saveGlossary = (entries: GlossaryEntry[]) =>
    this.writeJson(
      path.join(this.root, 'glossary.json'),
      entries.filter((e) => e.source.trim() && e.target.trim()),
    );

  async jobs(): Promise<Job[]> {
    const dir = path.join(this.root, 'jobs');
    const ids = await readdir(dir).catch(() => [] as string[]);
    const jobs = await Promise.all(ids.map((id) => this.readJson<Job | null>(path.join(dir, id, 'job.json'), null)));
    return jobs.filter((j): j is Job => j !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  job = (id: string) => this.readJson<Job | null>(path.join(this.jobDir(id), 'job.json'), null);
  saveJob = (job: Job) => this.writeJson(path.join(this.jobDir(job.id), 'job.json'), job);
  segments = (id: string) => this.readJson<Segment[]>(path.join(this.jobDir(id), 'segments.json'), []);
  saveSegments = (id: string, segments: Segment[]) => this.writeJson(path.join(this.jobDir(id), 'segments.json'), segments);
  inputPath = (job: Job) => path.join(this.jobDir(job.id), `input${job.ext}`);
  deleteJob = (id: string) => rm(this.jobDir(id), { recursive: true, force: true });
}
