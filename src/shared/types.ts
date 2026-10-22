export type Mode = 'fast' | 'balanced' | 'quality';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type Stage = 'prepare' | 'extract' | 'ocr' | 'tables' | 'context' | 'translate' | 'check' | 'fix' | 'write' | 'layout';
export type SegmentKind = 'heading' | 'paragraph' | 'list' | 'table';
/** mono = černobílý vysoký kontrast (vždy světlý podklad). */
export type Theme = 'system' | 'light' | 'dark' | 'mono';

/** Obdélník na stránce PDF v bodech viewportu pdf.js (scale 1, počátek vlevo nahoře). */
export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Délka zdroje v tomto obdélníku; podle ní se překlad dělí mezi obdélníky. */
  chars?: number;
  /** Plochy s původním textem [x, y, w, h] (úseky řádků); bez nich se překryje celý obdélník. */
  cover?: [number, number, number, number][];
}

/** Odkaz v textu segmentu (z anotace Link v PDF). */
export interface SegmentLink {
  /** Bez URL je to odkaz na místo v dokumentu (jen v PDF). */
  url?: string;
  /** Text odkazu v originálu. */
  source: string;
  /** Text odkazu přeložený zvlášť; podle něj se odkaz hledá v překladu. */
  target?: string;
  /** Klikací plochy originálu, u odkazu zalomeného přes řádek víc. */
  rects: Rect[];
}

export interface Segment {
  id: number;
  kind: SegmentKind;
  page?: number;
  source: string;
  translation?: string;
  polished?: string;
  /** Ruční úprava uživatele (fáze 2: překladová paměť). */
  edited?: string;
  rating?: 1 | -1;
  warning?: string;
  /** Umístění v PDF pro přeložené PDF se zachovaným vzhledem. */
  rects?: Rect[];
  /** Typická výška písma v bodech. */
  fontSize?: number;
  serif?: boolean;
  bold?: boolean;
  /** Řádky originálu jsou zarovnané na střed. */
  centered?: boolean;
  /** Jen pro přeložené PDF (zvýrazněný citát opakující větu z článku); jinde se nezobrazuje. */
  layoutOnly?: boolean;
  links?: SegmentLink[];
}

export interface Progress {
  stage: Stage;
  done: number;
  total: number;
  /** Odhad zbývajících sekund pro celou úlohu. */
  eta?: number;
}

export interface Job {
  id: string;
  name: string;
  ext: string;
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  status: JobStatus;
  /** Vybrané stránky PDF, např. „1-8“; prázdné = všechny. */
  pageRange?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  pages?: number;
  chars?: number;
  warnings: number;
  progress?: Progress;
  /** Název výstupního souboru ve složce úlohy. */
  output?: string;
  /** Přeložené PDF se zachovaným vzhledem ve složce úlohy. */
  outputPdf?: string;
  /** Doba jednotlivých fází v sekundách. */
  timings?: Partial<Record<Stage, number>>;
  /** Kontext dokumentu (jen režim Kvalitní). */
  context?: DocumentContext;
  /** Poznámky k celé úloze, např. přeskočená kontrola pravopisu. */
  notes?: string[];
}

export interface DocumentContext {
  topic: string;
  domain: string;
  author: string;
  authorGender: 'female' | 'male' | 'unknown';
  audience: string;
  /** Termíny dokumentu, `target` je v cílovém jazyce. */
  terms: GlossaryEntry[];
}

export interface JobOptions {
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  pageRange?: string;
}

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface Models {
  ocr: string;
  translate: string;
  polish: string;
}

/** Průměrné rychlosti pro odhad zbývajícího času (sekundy). */
export interface Rates {
  ocrPerPage: number;
  translatePerKChar: number;
  fixPerSegment: number;
}

export interface Settings {
  apiUrl: string;
  models: Models;
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  notify: boolean;
  unloadWhenIdle: boolean;
  theme: Theme;
  /** U PDF vytvořit i přeložené PDF se zachovaným vzhledem. */
  layoutPdf: boolean;
  rates: Rates;
}

export interface LmStatus {
  online: boolean;
  cli: boolean;
  models: { key: string; name: string; vision: boolean; sizeBytes: number }[];
  missing: (keyof Models)[];
}

export type OutputKind = 'docx' | 'pdf';

export interface JobDetail {
  job: Job;
  segments: Segment[];
}

export interface Api {
  platform: string;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getGlossary(): Promise<GlossaryEntry[]>;
  saveGlossary(entries: GlossaryEntry[]): Promise<void>;
  lmStatus(): Promise<LmStatus>;
  pickFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  addJobs(paths: string[], options: JobOptions): Promise<void>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<JobDetail | null>;
  readInput(id: string): Promise<Uint8Array | null>;
  readOutputPdf(id: string): Promise<Uint8Array | null>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string, mode: Mode): Promise<void>;
  deleteJob(id: string): Promise<void>;
  openOutput(id: string, kind?: OutputKind): Promise<void>;
  revealOutput(id: string): Promise<void>;
  saveOutputAs(id: string): Promise<void>;
  onJobUpdate(handler: (job: Job) => void): void;
  onJobRemoved(handler: (id: string) => void): void;
  /** Klik na notifikaci otevře detail úlohy. */
  onOpenJob(handler: (id: string) => void): void;
}
