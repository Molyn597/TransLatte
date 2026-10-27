import { FAST_REMOTE_MODEL, isFreeModel, RECOMMENDED_REMOTE_MODEL } from './provider';
import type { LmStatus, Models } from './types';

type CatalogEntry = LmStatus['models'][number];

export const MAX_ROWS = 50;

export interface CatalogFilter {
  text: string;
  visionOnly: boolean;
  /** Vybrané modely se ukazují vždy, i když filtru neodpovídají. */
  keep?: string[];
}

export function filterCatalog(models: CatalogEntry[], { text, visionOnly, keep = [] }: CatalogFilter) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(
    (m) => keep.includes(m.key) || ((!visionOnly || m.vision) && words.every((w) => `${m.key} ${m.name}`.toLowerCase().includes(w))),
  );
}

/** Placený vstup a nulový výstup mají jen specializované nástroje (shrnutí, extrakce), ne modely pro překlad. */
const oddPrice = (m: CatalogEntry) => Boolean(m.price && m.price.input > 0 && m.price.output === 0);

/** Doporučený první, pak rychlá alternativa, modely s obrazem, a podle ceny výstupu vzestupně. */
export function sortCatalog(models: CatalogEntry[]) {
  const rank = (m: CatalogEntry) =>
    m.key === RECOMMENDED_REMOTE_MODEL ? 0 : m.key === FAST_REMOTE_MODEL ? 1 : oddPrice(m) ? 4 : m.vision ? 2 : 3;
  return [...models].sort((a, b) => rank(a) - rank(b) || (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity));
}

export function catalogRows(models: CatalogEntry[], filter: CatalogFilter, limit = MAX_ROWS) {
  const sorted = sortCatalog(filterCatalog(models, filter));
  return { rows: sorted.slice(0, limit), total: sorted.length };
}

/** Model, který mají společný všechny role; jinak nic. */
export function sharedModel(models: Models) {
  const [first, ...rest] = Object.values(models);
  return rest.every((m) => m === first) ? first : undefined;
}

/** Role, které potřebují obraz (OCR, opravy), ale vybraný model ho neumí. Neznámý model se nehlásí. */
export function visionWarnings(models: Models, catalog: CatalogEntry[]) {
  const known = new Map(catalog.map((m) => [m.key, m]));
  return (['ocr', 'polish'] as const)
    .map((role) => ({ role, model: models[role] }))
    .filter(({ model }) => known.has(model) && !known.get(model)!.vision);
}

export const isFree = (m: CatalogEntry) => isFreeModel(m.key) || (m.price?.input === 0 && m.price.output === 0);

/** 262144 -> "262k"; 1048576 -> "1M". */
export function formatContext(n?: number) {
  if (!n) return '—';
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`.replace('.0M', 'M');
  return `${Math.round(n / 1000)}k`;
}
