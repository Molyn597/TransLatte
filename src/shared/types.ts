import type { UiLangSetting } from './i18n';

export type Mode = 'fast' | 'balanced' | 'quality';
/** picking = PDF je přečtené, čeká se na výběr odstavců k překladu. */
export type JobStatus = 'queued' | 'running' | 'picking' | 'done' | 'error' | 'cancelled';
export type Stage = 'prepare' | 'extract' | 'ocr' | 'tables' | 'context' | 'translate' | 'check' | 'fix' | 'write' | 'layout';
export type SegmentKind = 'heading' | 'paragraph' | 'list' | 'table';
/** mono = černobílý vysoký kontrast (vždy světlý podklad). */
export type Theme = 'system' | 'light' | 'dark' | 'mono';
/** V jaké měně ukazovat ceny online modelů. */
export type Currency = 'both' | 'czk' | 'usd';

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
  /** Text uvnitř grafu nebo schématu: nepřekládá se, v PDF zůstane původní, ve Wordu není. */
  figure?: boolean;
  /** Nevybraný k překladu: v PDF zůstane původní, ve Wordu není. */
  skipped?: boolean;
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
  /** Po přečtení PDF počkat na výběr odstavců. */
  pickParagraphs?: boolean;
  /** Další běh pokračuje z uložených segmentů a přeloží jen vybrané nepřeložené. */
  resume?: boolean;
  /** Poskytovatel modelů, který úlohu zpracoval (bez hodnoty = lokální). */
  provider?: Provider;
  /** Modely, které úlohu zpracovaly (pro zobrazení). */
  models?: Models;
  /** Cena za online modely v USD (součet za úlohu i překlady oblastí). */
  cost?: number;
  /** Odhad ceny po přečtení dokumentu (USD, s koeficientem) a bez něj pro zpřesnění koeficientu. */
  costEstimate?: number;
  costBase?: number;
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
  pickParagraphs?: boolean;
  /** Bez hodnoty = podle nastavení v okamžiku spuštění. */
  provider?: Provider;
}

/** Oblast stránky přeložená na vyžádání (study.json ve složce úlohy). */
export interface RegionTranslation {
  page: number;
  /** Výřez [x0, y0, x1, y1] v poměru ke stránce (0–1). */
  crop: [number, number, number, number];
  text: string;
  createdAt: number;
}

export interface GlossaryEntry {
  source: string;
  target: string;
}

export type Provider = 'local' | 'openrouter';

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
  /** Jazyk rozhraní aplikace (ne překladu). */
  uiLang: UiLangSetting;
  apiUrl: string;
  provider: Provider;
  /** Modely lokálního LM Studia. */
  models: Models;
  /** Modely OpenRouter (id z jejich katalogu). */
  remoteModels: Models;
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  notify: boolean;
  unloadWhenIdle: boolean;
  theme: Theme;
  /** U PDF vytvořit i přeložené PDF se zachovaným vzhledem. */
  layoutPdf: boolean;
  rates: Rates;
  /** Rychlosti online modelů (odhad času se u nich počítá zvlášť). */
  remoteRates: Rates;
  /** Opravné koeficienty odhadu ceny podle sady modelů (skutečná / odhadnutá cena). */
  remoteCostFactors: Record<string, number>;
  currency: Currency;
  /** Poslední kurz USD → CZK z ČNB (pro ceny i v korunách). */
  usdCzk?: { rate: number; date: string };
}

export interface LmStatus {
  /** Bez hodnoty = lokální. */
  provider?: Provider;
  online: boolean;
  cli: boolean;
  /** Jen OpenRouter: je uložený API klíč. */
  hasKey?: boolean;
  models: { key: string; name: string; vision: boolean; sizeBytes: number; price?: ModelPrice; context?: number }[];
  /** Jen OpenRouter: čas stažení katalogu (ms). */
  catalogAt?: number;
  missing: (keyof Models)[];
}

/** Co o souboru zjistí hlavní proces před přidáním úlohy (pro odhad ceny). */
export type FileInfo = { kind: 'pdf'; pages: number } | { kind: 'text'; chars: number } | { kind: 'docx' };

/** Cena modelu v USD za milion tokenů. */
export interface ModelPrice {
  input: number;
  output: number;
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
  lmStatus(provider?: Provider): Promise<LmStatus>;
  /** Znovu stáhne katalog OpenRouter mimo mezipaměť. */
  refreshCatalog(): Promise<void>;
  /** API klíč OpenRouter žije jen v hlavním procesu; do okna se nikdy nevrací. */
  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
  /** Rozsah souborů pro odhad ceny; nečitelný soubor se vynechá. */
  /** Ve stejném pořadí jako `paths`; nečitelný soubor = null. */
  fileInfo(paths: string[]): Promise<(FileInfo | null)[]>;
  usdCzk(): Promise<number | undefined>;
  pickFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  addJobs(paths: string[], options: JobOptions): Promise<void>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<JobDetail | null>;
  readInput(id: string): Promise<Uint8Array | null>;
  readOutputPdf(id: string): Promise<Uint8Array | null>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string, mode: Mode): Promise<void>;
  relayoutJob(id: string): Promise<void>;
  /** Přeloží vybrané segmenty (id) úlohy čekající na výběr nebo hotové; ostatní nepřeložené se přeskočí. */
  translateSegments(id: string, ids: number[]): Promise<void>;
  jobRegions(id: string): Promise<RegionTranslation[]>;
  translateRegion(id: string, page: number, crop: RegionTranslation['crop']): Promise<RegionTranslation>;
  deleteJob(id: string): Promise<void>;
  openOutput(id: string, kind?: OutputKind): Promise<void>;
  revealOutput(id: string): Promise<void>;
  saveOutputAs(id: string): Promise<void>;
  onJobUpdate(handler: (job: Job) => void): void;
  onJobRemoved(handler: (id: string) => void): void;
  /** Klik na notifikaci otevře detail úlohy. */
  onOpenJob(handler: (id: string) => void): void;
}
