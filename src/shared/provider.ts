import type { Models, Provider, Rates, Settings } from './types';

/** Doporučený model OpenRouter pro všechny role; jediné místo, kde je jeho id (vítěz srovnání češtiny 10/2026). */
export const RECOMMENDED_REMOTE_MODEL = 'deepseek/deepseek-v4.1-flash';
/** Rychlá alternativa: asi 3× rychlejší, zhruba dvojnásobná cena. */
export const FAST_REMOTE_MODEL = 'google/gemini-3.1-flash-lite';

/** Souběžné požadavky: online služba zvládne víc než jeden počítač. */
export const PARALLEL: Record<Provider, number> = { local: 4, openrouter: 8 };

type ProviderSettings = Pick<Settings, 'models' | 'remoteModels' | 'rates' | 'remoteRates'> & { provider?: Provider };

/** Bezplatné modely OpenRouter mají tvrdý limit 20 požadavků za minutu. */
export const isFreeModel = (id: string) => id.endsWith(':free');

export const isOnline = (s: { provider?: Provider }) => s.provider === 'openrouter';
export const activeModels = (s: ProviderSettings): Models => (isOnline(s) ? s.remoteModels : s.models);
/** Souběžné požadavky podle poskytovatele; s bezplatným modelem jen jeden. */
export const parallelFor = (s: ProviderSettings) =>
  isOnline(s) && Object.values(s.remoteModels).some(isFreeModel) ? 1 : PARALLEL[s.provider ?? 'local'];
export const activeRates = (s: ProviderSettings): Rates => (isOnline(s) ? s.remoteRates : s.rates);
