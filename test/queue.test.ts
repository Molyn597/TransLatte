import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Segment } from '../src/shared/types';
import { Queue } from '../src/main/queue';

const runJob = vi.hoisted(() => vi.fn());

vi.mock('../src/main/pipeline', () => ({ runJob }));
vi.mock('../src/main/lmstudio', () => ({ unloadAll: vi.fn() }));

function makeStore() {
  const jobs = new Map<string, Job>();
  const segments = new Map<string, Segment[]>();
  let settings: Record<string, unknown> = { provider: 'local', remoteRates: { ocrPerPage: 10, translatePerKChar: 10, fixPerSegment: 10 }, rates: { ocrPerPage: 1, translatePerKChar: 1, fixPerSegment: 1 }, unloadWhenIdle: false };
  const store = {
    jobs,
    job: async (id: string) => jobs.get(id),
    saveJob: async (job: Job) => void jobs.set(job.id, job),
    settings: async () => settings,
    saveSettings: async (s: typeof settings) => void (settings = s),
    glossary: async () => [],
    segments: async (id: string) => segments.get(id) ?? [],
    saveSegments: async (id: string, list: Segment[]) => void segments.set(id, list),
    jobDir: (id: string) => `/tmp/jobs/${id}`,
    inputPath: (job: Job) => `/tmp/jobs/${job.id}/input${job.ext}`,
    setSegments: (id: string, list: Segment[]) => segments.set(id, list),
  };
  return store;
}

function makeEvents() {
  return { update: vi.fn(), finished: vi.fn(), idle: vi.fn() };
}

const makeJob = (id: string, extra: Partial<Job> = {}) =>
  ({
    id,
    name: id,
    ext: '.pdf',
    mode: 'fast',
    sourceLang: 'en',
    targetLang: 'cs',
    status: 'queued',
    createdAt: 0,
    warnings: 0,
    ...extra,
  }) as Job;

describe('Queue', () => {
  let store: ReturnType<typeof makeStore>;
  let events: ReturnType<typeof makeEvents>;
  let queue: Queue;

  beforeEach(() => {
    runJob.mockReset();
    store = makeStore();
    events = makeEvents();
    queue = new Queue(store as never, events);
  });

  describe('exclusive', () => {
    it('počká na běžící úlohu a spustí se dřív než čekající úloha', async () => {
      const log: string[] = [];
      let finishA!: () => void;
      const gateA = new Promise<void>((r) => (finishA = r));
      runJob.mockImplementation(async ({ job }: { job: Job }) => {
        log.push(`start ${job.id}`);
        if (job.id === 'a') await gateA;
        log.push(`end ${job.id}`);
        return {};
      });

      queue['enqueue'](makeJob('a'));
      await vi.waitFor(() => expect(log).toEqual(['start a']));

      const excl = queue.exclusive(async () => {
        log.push('excl');
      });
      queue['enqueue'](makeJob('b'));

      finishA();
      await excl;
      await vi.waitFor(() => expect(store.jobs.get('b')?.status).toBe('done'));
      expect(log).toEqual(['start a', 'end a', 'excl', 'start b', 'end b']);
    });

    it('bez běžící úlohy se spustí hned a vrátí výsledek', async () => {
      await expect(queue.exclusive(async () => 42)).resolves.toBe(42);
    });

    it('chyba ve fn se propaguje jako reject a fronta pokračuje', async () => {
      runJob.mockResolvedValue({});
      await expect(
        queue.exclusive(async () => {
          throw new Error('selhalo');
        }),
      ).rejects.toThrow('selhalo');

      queue['enqueue'](makeJob('c'));
      await vi.waitFor(() => expect(store.jobs.get('c')?.status).toBe('done'));
    });
  });

  describe('translateSegments', () => {
    it('u úlohy ve stavu picking přepne výběr segmentů a po doběhnutí je hotovo', async () => {
      runJob.mockResolvedValue({});
      store.jobs.set('p', makeJob('p', { status: 'picking', output: 'out.docx', resume: true }));
      store.setSegments('p', [
        { id: 1, kind: 'paragraph', source: 'a' },
        { id: 2, kind: 'paragraph', source: 'b', translation: 'B' },
        { id: 3, kind: 'paragraph', source: 'c', skipped: true },
        { id: 4, kind: 'paragraph', source: 'd' },
      ]);

      await queue.translateSegments('p', [3]);
      const segs = await store.segments('p');
      expect(segs.map((s) => s.skipped)).toEqual([true, undefined, undefined, true]);
      expect(segs[1].translation).toBe('B');

      await vi.waitFor(() => expect(store.jobs.get('p')?.status).toBe('done'));
      expect(store.jobs.get('p')?.resume).toBeUndefined();
    });

    it('když runJob vrátí paused, úloha zůstane ve stavu picking', async () => {
      runJob.mockResolvedValue({ paused: true });
      queue['enqueue'](makeJob('q'));
      await vi.waitFor(() => expect(store.jobs.get('q')?.status).toBe('picking'));
    });
  });

  describe('cancel', () => {
    it('zrušení běžící úlohy s resume a output skončí jako done', async () => {
      runJob.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('zrušeno'))),
          ),
      );
      queue['enqueue'](makeJob('r', { resume: true, output: 'out.docx' }));
      await vi.waitFor(() => expect(runJob).toHaveBeenCalled());

      await queue.cancel('r');
      await vi.waitFor(() => expect(store.jobs.get('r')?.status).toBe('done'));
    });
  });

  describe('rychlosti podle poskytovatele', () => {
    const run = async (provider: string) => {
      runJob.mockResolvedValue({ translatePerKChar: 11 });
      Object.assign(await store.settings(), { provider });
      queue['enqueue'](makeJob(`rate-${provider}`));
      await vi.waitFor(() => expect(store.jobs.get(`rate-${provider}`)?.status).toBe('done'));
      return store.settings() as Promise<Record<string, { translatePerKChar: number }>>;
    };

    it('lokální úloha zpřesní rates, ne remoteRates', async () => {
      const s = await run('local');
      expect(s.rates.translatePerKChar).toBeCloseTo(4);
      expect(s.remoteRates.translatePerKChar).toBe(10);
      expect(store.jobs.get('rate-local')?.provider).toBe('local');
    });

    it('online úloha zpřesní remoteRates, ne rates', async () => {
      const s = await run('openrouter');
      expect(s.remoteRates.translatePerKChar).toBeCloseTo(10.3);
      expect(s.rates.translatePerKChar).toBe(1);
      expect(store.jobs.get('rate-openrouter')?.provider).toBe('openrouter');
    });
  });
});
