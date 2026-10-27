import { t } from '../shared/i18n';
import type { LmStatus, ModelPrice, Models, Provider, Settings } from '../shared/types';

export const OPENROUTER_API = 'https://openrouter.ai/api';
const CATALOG_TTL = 60 * 60 * 1000;

/** Kam se posílají požadavky a s jakými hlavičkami. */
export interface Endpoint {
  provider: Provider;
  baseUrl: string;
  headers: Record<string, string>;
}

export function resolveEndpoint(settings: Pick<Settings, 'provider' | 'apiUrl'>, apiKey?: string): Endpoint {
  if (settings.provider !== 'openrouter') return { provider: 'local', baseUrl: settings.apiUrl, headers: {} };
  if (!apiKey) throw new Error(t('openrouter.noKey'));
  return {
    provider: 'openrouter',
    baseUrl: OPENROUTER_API,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/Molyn597/TransLatte',
      'X-OpenRouter-Title': 'TransLatte',
    },
  };
}

// ---------- Omezení bezplatných modelů ----------

export const FREE_SPACING_MS = 3100;
let nextSlot = 0;

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export const resetThrottle = () => (nextSlot = 0);

/** Společná fronta: požadavky na bezplatné modely začínají nejméně 3,1 s po sobě (limit 20 za minutu). */
export async function throttleFree(signal?: AbortSignal) {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + FREE_SPACING_MS;
  if (start > now) await sleep(start - now, signal);
}

// ---------- Katalog modelů ----------

export interface CatalogModel {
  id: string;
  name: string;
  vision: boolean;
  /** Cena za 1M tokenů. */
  price?: ModelPrice;
  /** Délka kontextu v tokenech. */
  context?: number;
  /** Údaj o uvažování z katalogu; bez něj model uvažování nezná. */
  reasoning?: ReasoningInfo;
}

interface ReasoningInfo {
  mandatory?: boolean;
  /** Od nejvyššího po nejnižší. */
  supported_efforts?: string[] | null;
}

interface RawModel {
  id: string;
  name?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
  reasoning?: boolean | ReasoningInfo;
}

const perMillion = (v?: string) => Math.round(Number(v) * 1e6 * 1000) / 1000;

export function parseCatalog(raw: RawModel[]): CatalogModel[] {
  return raw
    .filter((m) => (m.architecture?.output_modalities ?? ['text']).every((x) => x === 'text'))
    // Routery s proměnnou cenou mají v katalogu cenu -1; nejde odhadnout, kolik stojí.
    .filter((m) => Number(m.pricing?.prompt ?? 0) >= 0 && Number(m.pricing?.completion ?? 0) >= 0)
    .map((m) => {
      const input = perMillion(m.pricing?.prompt);
      const output = perMillion(m.pricing?.completion);
      return {
        id: m.id,
        name: m.name ?? m.id,
        vision: Boolean(m.architecture?.input_modalities?.includes('image')),
        price: Number.isFinite(input) && Number.isFinite(output) ? { input, output } : undefined,
        context: m.context_length || undefined,
        reasoning: m.reasoning ? (typeof m.reasoning === 'object' ? m.reasoning : {}) : undefined,
      };
    });
}

let cache: { at: number; models: CatalogModel[] } | undefined;

export const resetCatalogCache = () => (cache = undefined);

/** Kdy byl katalog naposledy stažen (ms), nebo nic. */
export const catalogAt = () => cache?.at;

/** Ruční aktualizace: obejde hodinovou mezipaměť. */
export function refreshCatalog() {
  resetCatalogCache();
  return fetchCatalog();
}

export async function fetchCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.at < CATALOG_TTL) return cache.models;
  const res = await fetch(`${OPENROUTER_API}/v1/models`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(t('lmstudio.httpError', { status: res.status, body: '' }));
  const models = parseCatalog(((await res.json()) as { data: RawModel[] }).data);
  cache = { at: Date.now(), models };
  return models;
}

/** Ceny modelů za 1M tokenů podle id. */
export async function catalogPrices(): Promise<Record<string, ModelPrice | undefined>> {
  return Object.fromEntries((await fetchCatalog()).map((m) => [m.id, m.price]));
}

export async function isRemoteVision(id: string) {
  return (await fetchCatalog().catch(() => [])).some((m) => m.id === id && m.vision);
}

// ---------- Uvažování ----------

/**
 * `effort: none` zná jen model, který uvažování umí vypnout. Povinné uvažování ho odmítne
 * a bez parametru běží s výchozím úsilím (u GLM `max`), proto dostane nejnižší nabízené.
 */
export function reasoningFor(entry?: CatalogModel): Record<string, unknown> {
  const info = entry?.reasoning;
  if (!info) return {};
  if (!info.mandatory) return { reasoning: { effort: 'none', exclude: true } };
  const lowest = info.supported_efforts?.at(-1);
  return { reasoning: { ...(lowest ? { effort: lowest } : {}), exclude: true } };
}

/** Přemýšlecí modely (Gemma 4) by jinak strávily stovky tokenů úvahami. */
export async function reasoningParams(endpoint: Endpoint, model: string) {
  if (endpoint.provider === 'local') return { reasoning_effort: 'none' };
  const catalog = await fetchCatalog().catch(() => []);
  return reasoningFor(catalog.find((m) => m.id === model));
}

// ---------- Stav ----------

async function keyValid(endpoint: Endpoint) {
  try {
    const res = await fetch(`${OPENROUTER_API}/v1/key`, { headers: endpoint.headers, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function openrouterStatus(models: Models, apiKey?: string): Promise<LmStatus> {
  const endpoint = apiKey ? resolveEndpoint({ provider: 'openrouter', apiUrl: '' }, apiKey) : undefined;
  const [online, catalog] = await Promise.all([endpoint ? keyValid(endpoint) : false, fetchCatalog().catch(() => [])]);
  const ids = new Set(catalog.map((m) => m.id));
  return {
    provider: 'openrouter',
    online,
    cli: false,
    hasKey: Boolean(apiKey),
    models: catalog.map((m) => ({ key: m.id, name: m.name, vision: m.vision, sizeBytes: 0, price: m.price, context: m.context })),
    catalogAt: catalogAt(),
    missing: catalog.length ? (Object.keys(models) as (keyof Models)[]).filter((role) => !ids.has(models[role])) : [],
  };
}
