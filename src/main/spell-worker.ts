import { parentPort, workerData } from 'node:worker_threads';
import { createChecker, spellBatch, type SpellItem } from './spell';

// Načtení slovníku trvá ~2,7 s a zabere ~380 MB, proto běží mimo hlavní vlákno.
const { aff, dic } = workerData as { aff: Uint8Array; dic: Uint8Array };
const checker = createChecker(Buffer.from(aff), Buffer.from(dic));

parentPort!.on('message', ({ id, items }: { id: number; items: SpellItem[] }) => {
  try {
    parentPort!.postMessage({ id, result: spellBatch(checker, items) });
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message });
  }
});
