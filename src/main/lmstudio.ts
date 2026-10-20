import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LmStatus, Models } from '../shared/types';

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
    throw new Error('LM Studio není spuštěné a jeho příkaz „lms“ se nenašel. Spusť LM Studio a zapni v něm server.');
  }
  await lms(['server', 'start']);
  if (!(await serverUp(apiUrl))) throw new Error(`Server LM Studia neodpovídá na ${apiUrl}.`);
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
    throw new Error(`Model „${modelKey}“ se nepodařilo načíst. Je stažený v LM Studiu? (${(e as Error).message})`);
  }
}

export async function unloadAll() {
  if (existsSync(lmsPath())) await lms(['unload', '--all']).catch(() => undefined);
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`LM Studio vrátilo chybu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function complete(
  apiUrl: string,
  model: string,
  prompt: string,
  opts: { stop: string[]; maxTokens: number; signal?: AbortSignal },
) {
  const data = await post<{ choices: { text: string }[] }>(
    `${apiUrl}/v1/completions`,
    { model, prompt, temperature: 0, max_tokens: opts.maxTokens, stop: opts.stop },
    opts.signal,
  );
  return data.choices[0]?.text.trim() ?? '';
}

export type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

export async function chat(
  apiUrl: string,
  model: string,
  messages: { role: 'system' | 'user'; content: ChatContent }[],
  opts: { maxTokens: number; temperature?: number; signal?: AbortSignal },
) {
  const data = await post<{ choices: { message: { content: string | null } }[] }>(
    `${apiUrl}/v1/chat/completions`,
    {
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens,
      // Přemýšlecí modely (Gemma 4) by jinak strávily stovky tokenů úvahami.
      reasoning_effort: 'none',
    },
    opts.signal,
  );
  return data.choices[0]?.message.content?.trim() ?? '';
}
