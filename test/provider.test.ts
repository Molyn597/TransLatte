import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeModels, activeRates, isFreeModel, parallelFor, PARALLEL, RECOMMENDED_REMOTE_MODEL } from '../src/shared/provider';
import { DEFAULT_SETTINGS, Store } from '../src/main/store';
import { FREE_SPACING_MS, parseCatalog, reasoningFor, resetThrottle, resolveEndpoint, throttleFree } from '../src/main/provider';

describe('nastavení', () => {
  it('starý settings.json bez online položek se doplní výchozími', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tl-'));
    await writeFile(
      path.join(root, 'settings.json'),
      JSON.stringify({ apiUrl: 'http://x', models: { ocr: 'a' }, rates: { ocrPerPage: 2, polishPerKChar: 9 } }),
    );
    const s = await new Store(root).settings();
    expect(s.provider).toBe('local');
    expect(s.models).toEqual({ ...DEFAULT_SETTINGS.models, ocr: 'a' });
    expect(s.remoteModels).toEqual({ ocr: RECOMMENDED_REMOTE_MODEL, translate: RECOMMENDED_REMOTE_MODEL, polish: RECOMMENDED_REMOTE_MODEL });
    expect(s.rates).toEqual({ ocrPerPage: 2, translatePerKChar: 25, fixPerSegment: 8 });
    expect(s.remoteRates).toEqual(DEFAULT_SETTINGS.remoteRates);
  });

  it('uložené online položky se zachovají a nikdy v nich není klíč', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tl-'));
    await writeFile(
      path.join(root, 'settings.json'),
      JSON.stringify({ provider: 'openrouter', remoteModels: { translate: 'x/y' }, remoteRates: { ocrPerPage: 1 } }),
    );
    const s = await new Store(root).settings();
    expect(s.provider).toBe('openrouter');
    expect(s.remoteModels.translate).toBe('x/y');
    expect(s.remoteModels.ocr).toBe(RECOMMENDED_REMOTE_MODEL);
    expect(s.remoteRates).toEqual({ ...DEFAULT_SETTINGS.remoteRates, ocrPerPage: 1 });
    expect(JSON.stringify(s)).not.toMatch(/key/i);
  });

  it('modely a rychlosti podle poskytovatele', () => {
    const local = { ...DEFAULT_SETTINGS, provider: 'local' as const };
    const online = { ...DEFAULT_SETTINGS, provider: 'openrouter' as const };
    expect(activeModels(local)).toBe(local.models);
    expect(activeModels(online)).toBe(online.remoteModels);
    expect(activeRates(local)).toBe(local.rates);
    expect(activeRates(online)).toBe(online.remoteRates);
  });
});

describe('souběžnost', () => {
  it('4 lokálně, 8 online, 1 s bezplatným modelem', () => {
    expect(PARALLEL).toEqual({ local: 4, openrouter: 8 });
    expect(parallelFor({ ...DEFAULT_SETTINGS, provider: 'local' })).toBe(4);
    expect(parallelFor({ ...DEFAULT_SETTINGS, provider: 'openrouter' })).toBe(8);
    const free = { ...DEFAULT_SETTINGS, provider: 'openrouter' as const, remoteModels: { ...DEFAULT_SETTINGS.remoteModels, translate: 'a/b:free' } };
    expect(parallelFor(free)).toBe(1);
    expect(parallelFor({ ...free, provider: 'local' })).toBe(4);
    expect(isFreeModel('a/b:free')).toBe(true);
    expect(isFreeModel('a/b')).toBe(false);
  });
});

describe('endpoint', () => {
  it('lokální bez hlaviček, OpenRouter s klíčem', () => {
    expect(resolveEndpoint({ provider: 'local', apiUrl: 'http://h:1' })).toEqual({ provider: 'local', baseUrl: 'http://h:1', headers: {} });
    const ep = resolveEndpoint({ provider: 'openrouter', apiUrl: 'http://h:1' }, 'k');
    expect(ep.baseUrl).toBe('https://openrouter.ai/api');
    expect(ep.headers).toEqual({
      Authorization: 'Bearer k',
      'HTTP-Referer': 'https://github.com/Molyn597/TransLatte',
      'X-OpenRouter-Title': 'TransLatte',
    });
  });

  it('OpenRouter bez klíče selže hned', () => {
    expect(() => resolveEndpoint({ provider: 'openrouter', apiUrl: '' })).toThrow();
  });
});

describe('katalog a uvažování', () => {
  const catalog = parseCatalog([
    { id: 'a', name: 'A', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
    { id: 'img', architecture: { output_modalities: ['text', 'image'] } },
    { id: 'r', reasoning: { mandatory: true } },
    { id: 'o', reasoning: {} },
    { id: 'glm', reasoning: { mandatory: true, supported_efforts: ['max', 'high', 'low'] } },
    { id: 'router', pricing: { prompt: '-1', completion: '-1' } },
  ]);

  it('filtruje na textový výstup bez routerů, počítá vision a cenu za 1M', () => {
    expect(catalog.map((m) => m.id)).toEqual(['a', 'r', 'o', 'glm']);
    expect(catalog[0]).toMatchObject({ vision: true, price: { input: 0.1, output: 0.4 } });
    expect(catalog[1].vision).toBe(false);
  });

  it('reasoning: nic / vypnutelné / povinné s nejnižším úsilím', () => {
    expect(reasoningFor(catalog[0])).toEqual({});
    expect(reasoningFor(catalog[2])).toEqual({ reasoning: { effort: 'none', exclude: true } });
    expect(reasoningFor(catalog[1])).toEqual({ reasoning: { exclude: true } });
    expect(reasoningFor(catalog[3])).toEqual({ reasoning: { effort: 'low', exclude: true } });
    expect(reasoningFor(undefined)).toEqual({});
  });
});

describe('throttle bezplatných modelů', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThrottle();
  });

  it('požadavky začínají nejméně 3,1 s po sobě', async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const run = () => throttleFree().then(() => starts.push(Date.now() - t0));
    const all = Promise.all([run(), run(), run()]);
    await vi.advanceTimersByTimeAsync(FREE_SPACING_MS * 3);
    await all;
    expect(starts).toEqual([0, FREE_SPACING_MS, FREE_SPACING_MS * 2]);
    vi.useRealTimers();
  });
});
