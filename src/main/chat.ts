import { t } from '../shared/i18n';
import { isOnline } from '../shared/provider';
import type { ChatMessage, Job, Settings } from '../shared/types';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { DOCUMENT_CHAT_SYSTEM, searchTermsPrompt } from './prompts';
import { cleanCitations, formatPassages, passages, search, selectPassages, totalChars } from './rag';
import type { Store } from './store';

// Lokální model má kontext 16k tokenů (~3,5 znaku na token): text dokumentu + historie + odpověď.
// Online (DeepSeek, 1M tokenů) se vejde i dlouhý dokument; nad limit už se vyplatí hledat.
const LIMITS = {
  local: { whole: 30000, found: 20000 },
  online: { whole: 400000, found: 60000 },
};
const HITS = 40;
const HISTORY = 4;
const HISTORY_CHARS = 1500;
const ANSWER_TOKENS = 1500;

/**
 * Odpověď z dokumentu s citacemi segmentů. Krátký dokument dostane model celý,
 * u dlouhého model nejdřív navrhne klíčová slova v obou jazycích a BM25 najde úseky.
 */
export async function askDocument(store: Store, job: Job, settings: Settings, question: string): Promise<ChatMessage> {
  const items = passages(await store.segments(job.id));
  if (!items.length) throw new Error(t('chat.empty'));
  const history = await store.chat(job.id);
  const llm: Llm = { job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.root) };
  const limit = LIMITS[isOnline(settings) ? 'online' : 'local'];
  await loadModel(llm, 'polish');

  const whole = totalChars(items) <= limit.whole;
  let chosen = items;
  if (!whole) {
    const previous = history.filter((m) => m.role === 'user').at(-1)?.text ?? '';
    const keywords = await ask(llm, 'polish', [{ role: 'user', content: searchTermsPrompt(question, job.sourceLang, job.targetLang) }], 300);
    chosen = selectPassages(items, search(items, `${question} ${previous} ${keywords}`, HITS), limit.found);
    // Bez zásahu aspoň začátek dokumentu (abstrakt, úvod), ať model může říct, o čem dokument je.
    if (!chosen.length) chosen = selectPassages(items, items, limit.found);
  }

  const recent = history.slice(-HISTORY).map((m) => ({ role: m.role, content: m.text.slice(0, HISTORY_CHARS) }));
  const raw = await ask(
    llm,
    'polish',
    [{ role: 'system', content: DOCUMENT_CHAT_SYSTEM + formatPassages(chosen) }, ...recent, { role: 'user', content: question }],
    ANSWER_TOKENS,
  );
  const { text, sources } = cleanCitations(raw, new Set(chosen.map((p) => p.id)));
  const answer: ChatMessage = { role: 'assistant', text: text || t('chat.noAnswer'), sources, whole, at: Date.now() };
  await store.saveChat(job.id, [...history, { role: 'user', text: question, at: Date.now() }, answer]);
  if (job.cost !== undefined) await store.saveJob(job);
  return answer;
}
