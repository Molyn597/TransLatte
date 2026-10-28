import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { RECOMMENDED_REMOTE_MODEL } from '../shared/provider';
import type { GlossaryEntry, Job, Rates, RegionTranslation, Segment, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  uiLang: 'system',
  apiUrl: 'http://localhost:1234',
  provider: 'local',
  models: { ocr: 'unlimited-ocr', translate: 'translategemma-12b-it', polish: 'google/gemma-4-12b-qat' },
  remoteModels: { ocr: RECOMMENDED_REMOTE_MODEL, translate: RECOMMENDED_REMOTE_MODEL, polish: RECOMMENDED_REMOTE_MODEL },
  mode: 'fast',
  sourceLang: 'auto',
  targetLang: 'cs',
  notify: true,
  unloadWhenIdle: true,
  theme: 'system',
  layoutPdf: true,
  keepFigures: true,
  rates: { ocrPerPage: 7, translatePerKChar: 25, fixPerSegment: 8 },
  remoteRates: { ocrPerPage: 6, translatePerKChar: 6, fixPerSegment: 3 },
  remoteCostFactors: {},
  currency: 'both',
};

/** Jen známé položky sazeb; starší nastavení měla místo fixPerSegment polishPerKChar. */
const mergeRates = (base: Rates, saved?: Partial<Rates>): Rates => {
  const { ocrPerPage, translatePerKChar, fixPerSegment } = { ...base, ...saved };
  return { ocrPerPage, translatePerKChar, fixPerSegment };
};

/** Úložiště pod userData: settings.json, glossary.json a jobs/<id>/{job.json, segments.json, study.json, vstup, výstup}. */
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
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      provider: saved.provider === 'openrouter' ? 'openrouter' : 'local',
      models: { ...DEFAULT_SETTINGS.models, ...saved.models },
      remoteModels: { ...DEFAULT_SETTINGS.remoteModels, ...saved.remoteModels },
      rates: mergeRates(DEFAULT_SETTINGS.rates, saved.rates),
      remoteRates: mergeRates(DEFAULT_SETTINGS.remoteRates, saved.remoteRates),
      remoteCostFactors: { ...saved.remoteCostFactors },
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
  regions = (id: string) => this.readJson<{ regions: RegionTranslation[] }>(path.join(this.jobDir(id), 'study.json'), { regions: [] }).then((s) => s.regions);
  saveRegions = (id: string, regions: RegionTranslation[]) => this.writeJson(path.join(this.jobDir(id), 'study.json'), { regions });
  inputPath = (job: Job) => path.join(this.jobDir(job.id), `input${job.ext}`);
  deleteJob = (id: string) => rm(this.jobDir(id), { recursive: true, force: true });
}
