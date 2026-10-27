import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { t } from '../shared/i18n';
import type { LmStatus, Models } from '../shared/types';
import { isFreeModel } from '../shared/provider';
import { reasoningParams, sleep, throttleFree, type Endpoint } from './provider';

const exec = promisify(execFile);

export const lmsPath = () =>
  path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');

async function lms(args: string[]) {
  const { stdout } = await exec(lmsPath(), args, { maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  return stdout;
}

interface LmsModel {
  type: string;
  modelKey: string;
  displayName?: string;
  vision?: boolean;
  sizeBytes?: number;
  identifier?: string;
}

export async function isVisionModel(modelKey: string) {
  return (await listModels().catch(() => [])).some((m) => m.modelKey === modelKey && m.vision);
}

export async function listModels(): Promise<LmsModel[]> {
  return (JSON.parse(await lms(['ls', '--json'])) as LmsModel[]).filter((m) => m.type === 'llm');
}

async function loadedModels(): Promise<LmsModel[]> {
  return JSON.parse(await lms(['ps', '--json'])) as LmsModel[];
}

async function serverUp(apiUrl: string) {
  try {
    const res = await fetch(`${apiUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function status(apiUrl: string, models: Models): Promise<LmStatus> {
  const cli = existsSync(lmsPath());
  const online = await serverUp(apiUrl);
  let available: LmsModel[] = [];
  if (cli) {
    try {
      available = await listModels();
    } catch {
      // LM Studio neběží ani na pozadí; seznam modelů prostě nebude.
    }
  }
  const keys = new Set(available.map((m) => m.modelKey));
  return {
    online,
    cli,
    models: available.map((m) => ({
      key: m.modelKey,
      name: m.displayName ?? m.modelKey,
      vision: Boolean(m.vision),
      sizeBytes: m.sizeBytes ?? 0,
    })),
    missing: cli ? (Object.keys(models) as (keyof Models)[]).filter((role) => !keys.has(models[role])) : [],
  };
}

export async function ensureServer(apiUrl: string) {
  if (await serverUp(apiUrl)) return;
  if (!existsSync(lmsPath())) {
    throw new Error(t('lmstudio.notInstalled'));
  }
  await lms(['server', 'start']);
  if (!(await serverUp(apiUrl))) throw new Error(t('lmstudio.noResponse', { url: apiUrl }));
}

/** V paměti je vždy jen jeden model (12B modely se do 16 GB vejdou jen po jednom). */
export async function ensureModel(modelKey: string, identifier: string) {
  const loaded = await loadedModels();
  if (loaded.some((m) => m.identifier === identifier && m.modelKey === modelKey)) return;
  if (loaded.length) await lms(['unload', '--all']);
  try {
    // 16k kontextu: LM Studio ho dělí mezi souběžné požadavky (pipeline jich posílá až 4).
    await lms(['load', modelKey, '-y', '-c', '16384', '--identifier', identifier]);
  } catch (e) {
    throw new Error(t('lmstudio.loadFailed', { model: modelKey, error: (e as Error).message }));
  }
}

export async function unloadAll() {
  if (existsSync(lmsPath())) await lms(['unload', '--all']).catch(() => undefined);
}

const RETRIES = 3;
const BACKOFF_MS = [2000, 4000, 8000];
const MAX_WAIT_MS = 60_000;

/** Retry-After v sekundách; bez něj se čeká 2, 4 a 8 s. */
function retryDelay(res: Response, attempt: number) {
  const seconds = Number(res.headers.get('Retry-After'));
  return Math.min(MAX_WAIT_MS, res.headers.has('Retry-After') && Number.isFinite(seconds) ? seconds * 1000 : BACKOFF_MS[attempt]);
}

function errorMessage(body: string) {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    return body;
  }
}

function budgetExhausted(body: string) {
  try {
    return (JSON.parse(body) as { error?: { metadata?: { reason?: string } } }).error?.metadata?.reason === 'in_flight_budget_exhausted';
  } catch {
    return false;
  }
}

async function post<T>(endpoint: Endpoint, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const free = endpoint.provider === 'openrouter' && isFreeModel((body as { model?: string }).model ?? '');
  for (let attempt = 0; ; attempt++) {
    if (free) await throttleFree(signal);
    const res = await fetch(`${endpoint.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...endpoint.headers },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    if (endpoint.provider === 'openrouter') {
      if (res.status === 401) throw new Error(t('openrouter.invalidKey'));
      if (res.status === 402 && !budgetExhausted(text)) throw new Error(t('openrouter.noCredits'));
      // 502/503: přetížený nebo nedostupný poskytovatel za OpenRouterem, obvykle přechodné.
      if (res.status === 429 || res.status === 402 || res.status === 502 || res.status === 503) {
        if (attempt >= RETRIES && free && res.status === 429) throw new Error(t('openrouter.freeDailyLimit'));
        if (attempt >= RETRIES) throw new Error(t('openrouter.rateLimited', { error: errorMessage(text).slice(0, 300) }));
        await sleep(retryDelay(res, attempt), signal);
        continue;
      }
    }
    throw new Error(t('lmstudio.httpError', { status: res.status, body: text.slice(0, 300) }));
  }
}

/** Jen lokální server; TranslateGemma na OpenRouter není, tam se používá chat. */
export async function complete(
  endpoint: Endpoint,
  model: string,
  prompt: string,
  opts: { stop: string[]; maxTokens: number; signal?: AbortSignal },
) {
  const data = await post<{ choices: { text: string }[] }>(
    endpoint,
    '/v1/completions',
    { model, prompt, temperature: 0, max_tokens: opts.maxTokens, stop: opts.stop },
    opts.signal,
  );
  return data.choices[0]?.text.trim() ?? '';
}

export type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

interface ChatResponse {
  choices: { message: { content: string | null } }[];
  usage?: { cost?: number };
  error?: { message?: string };
}

export async function chat(
  endpoint: Endpoint,
  model: string,
  messages: { role: 'system' | 'user'; content: ChatContent }[],
  opts: { maxTokens: number; temperature?: number; signal?: AbortSignal; onCost?: (usd: number) => void },
) {
  const data = await post<ChatResponse>(
    endpoint,
    '/v1/chat/completions',
    {
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens,
      ...(await reasoningParams(endpoint, model)),
    },
    opts.signal,
  );
  // OpenRouter občas vrátí chybu poskytovatele se stavem 200.
  if (data.error) throw new Error(t('lmstudio.httpError', { status: 200, body: data.error.message ?? '' }));
  if (data.usage?.cost) opts.onCost?.(data.usage.cost);
  return data.choices[0]?.message.content?.trim() ?? '';
}
