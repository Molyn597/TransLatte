import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '../src/shared/i18n';
import { chat } from '../src/main/lmstudio';
import { resetCatalogCache, resetThrottle, resolveEndpoint } from '../src/main/provider';

const local = resolveEndpoint({ provider: 'local', apiUrl: 'http://lm' });
const remote = resolveEndpoint({ provider: 'openrouter', apiUrl: '' }, 'sk-test');
const msgs = [{ role: 'user' as const, content: 'hi' }];
const opts = { maxTokens: 10 };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const ok = (cost?: number) => json({ choices: [{ message: { content: ' ahoj ' } }], usage: cost === undefined ? undefined : { cost } });

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
let calls: Call[];
let chatResponses: (() => Response)[];
let models: unknown[];

beforeEach(() => {
  setLang('cs');
  calls = [];
  chatResponses = [];
  models = [];
  resetCatalogCache();
  resetThrottle();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/v1/models')) return json({ data: models });
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return chatResponses.shift()!();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('chat', () => {
  it('lokálně: reasoning_effort none, bez autorizace', async () => {
    chatResponses.push(() => ok());
    expect(await chat(local, 'm', msgs, opts)).toBe('ahoj');
    expect(calls[0].url).toBe('http://lm/v1/chat/completions');
    expect(calls[0].body.reasoning_effort).toBe('none');
    expect(calls[0].body).not.toHaveProperty('reasoning');
    expect(calls[0].init.headers).not.toHaveProperty('Authorization');
  });

  it('OpenRouter: hlavičky a reasoning podle katalogu', async () => {
    models = [{ id: 'opt', reasoning: {} }, { id: 'mand', reasoning: { mandatory: true, supported_efforts: ['high', 'low'] } }, { id: 'plain' }];
    const cases = [['opt', { effort: 'none', exclude: true }], ['mand', { effort: 'low', exclude: true }], ['plain', undefined]] as const;
    for (const [model, expected] of cases) {
      chatResponses.push(() => ok());
      await chat(remote, model, msgs, opts);
      const body = calls.at(-1)!.body;
      expect(body.reasoning).toEqual(expected);
      expect(body).not.toHaveProperty('reasoning_effort');
    }
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer sk-test', 'X-OpenRouter-Title': 'TransLatte' });
  });

  it('sčítá cenu z usage.cost', async () => {
    chatResponses.push(() => ok(0.01), () => ok(0.0125), () => ok());
    let total = 0;
    const onCost = (usd: number) => (total += usd);
    for (let i = 0; i < 3; i++) await chat(remote, 'm', msgs, { ...opts, onCost });
    expect(total).toBeCloseTo(0.0225);
  });

  it('401 hned selže s hláškou o klíči', async () => {
    chatResponses.push(() => json({ error: { message: 'x' } }, 401));
    await expect(chat(remote, 'm', msgs, opts)).rejects.toThrow(t('openrouter.invalidKey'));
    expect(calls).toHaveLength(1);
  });

  it('402 bez kreditu selže bez opakování', async () => {
    chatResponses.push(() => json({ error: { message: 'credits' } }, 402));
    await expect(chat(remote, 'm', msgs, opts)).rejects.toThrow(t('openrouter.noCredits'));
    expect(calls).toHaveLength(1);
  });

  it('402 in_flight_budget_exhausted počká Retry-After a zkusí znovu', async () => {
    const budget = () => json({ error: { metadata: { reason: 'in_flight_budget_exhausted' } } }, 402, { 'Retry-After': '1' });
    chatResponses.push(budget, () => ok());
    vi.useFakeTimers();
    const p = chat(remote, 'm', msgs, opts);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('ahoj');
    expect(calls).toHaveLength(2);
  });

  it('429: tři opakování (2, 4, 8 s) a pak chyba se zprávou', async () => {
    for (let i = 0; i < 4; i++) chatResponses.push(() => json({ error: { message: 'slow down' } }, 429));
    vi.useFakeTimers();
    const assertion = expect(chat(remote, 'm', msgs, opts)).rejects.toThrow('slow down');
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(calls).toHaveLength(4);
  });

  it('429 s Retry-After čeká podle hlavičky a po opakování uspěje', async () => {
    chatResponses.push(() => json({}, 429, { 'Retry-After': '5' }), () => ok());
    vi.useFakeTimers();
    const p = chat(remote, 'm', msgs, opts);
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('ahoj');
  });

  it('502 od poskytovatele se zopakuje', async () => {
    chatResponses.push(() => json({ error: { message: 'upstream' } }, 502), () => ok());
    vi.useFakeTimers();
    const p = chat(remote, 'm', msgs, opts);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe('ahoj');
    expect(calls).toHaveLength(2);
  });

  it('bezplatný model: trvající 429 znamená denní limit', async () => {
    for (let i = 0; i < 4; i++) chatResponses.push(() => json({}, 429, { 'Retry-After': '0' }));
    vi.useFakeTimers();
    const assertion = expect(chat(remote, 'a/b:free', msgs, opts)).rejects.toThrow(t('openrouter.freeDailyLimit'));
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
  });

  it('bezplatný model: požadavky jsou od sebe nejméně 3,1 s', async () => {
    chatResponses.push(() => ok(), () => ok());
    vi.useFakeTimers();
    const p = Promise.all([chat(remote, 'a/b:free', msgs, opts), chat(remote, 'a/b:free', msgs, opts)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3100);
    await p;
    expect(calls).toHaveLength(2);
  });

  it('lokální chyba zůstává beze změny (429 se neopakuje)', async () => {
    chatResponses.push(() => json({}, 429));
    await expect(chat(local, 'm', msgs, opts)).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });
});
