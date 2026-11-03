import { t } from '../shared/i18n';
import { chatSettings, isOnline } from '../shared/provider';
import type { ChatMessage, ChatModel, Job, Settings } from '../shared/types';
import { readKey } from './keystore';
import { ask, askStream, connect, loadModel, type Llm } from './pipeline';
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
const FLUSH_MS = 50;
const KEYWORDS_SHOWN = 12;
const PAGES_SHOWN = 8;

export interface ChatHooks {
  /** Krok průběhu; `tags` jsou drobné štítky pod ním (klíčová slova). */
  step(step: string, tags?: string[]): void;
  /** Část odpovědi (`reasoning` = úvahy modelu); sloučené po ~50 ms. */
  delta(d: { content?: string; reasoning?: string }): void;
}

/**
 * Odpověď z dokumentu s citacemi segmentů. Krátký dokument dostane model celý,
 * u dlouhého model nejdřív navrhne klíčová slova v obou jazycích a BM25 najde úseky.
 */
export async function askDocument(store: Store, job: Job, base: Settings, question: string, model?: ChatModel, hooks?: ChatHooks): Promise<ChatMessage> {
  const started = Date.now();
  const steps: string[] = [];
  const step = (text: string, tags?: string[]) => {
    steps.push(tags?.length ? `${text}: ${tags.join(', ')}` : text);
    hooks?.step(text, tags);
  };
  const settings = chatSettings(base, model);
  const items = passages(await store.segments(job.id));
  if (!items.length) throw new Error(t('chat.empty'));
  if (isOnline(settings) && !(await readKey(store.root))) throw new Error(t('openrouter.noKey'));
  const history = await store.chat(job.id);
  const llm: Llm = { job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.root) };
  const limit = LIMITS[isOnline(settings) ? 'online' : 'local'];
  if (!isOnline(settings)) step(t('chat.stepLoad', { model: model?.name ?? settings.models.polish }));
  await loadModel(llm, 'polish');

  const whole = totalChars(items) <= limit.whole;
  let chosen = items;
  if (whole) {
    const pages = new Set(items.map((p) => p.page).filter(Boolean)).size;
    step(t(pages ? 'chat.stepWhole' : 'chat.stepWholeText', { n: pages }));
  } else {
    step(t('chat.stepKeywords'));
    const previous = history.filter((m) => m.role === 'user').at(-1)?.text ?? '';
    const keywords = await ask(llm, 'polish', [{ role: 'user', content: searchTermsPrompt(question, job.sourceLang, job.targetLang) }], 300);
    const words = [...new Set(keywords.split(/[\s,;]+/).filter(Boolean))];
    if (words.length) step(t('chat.stepTerms'), words.slice(0, KEYWORDS_SHOWN));
    chosen = selectPassages(items, search(items, `${question} ${previous} ${keywords}`, HITS), limit.found);
    // Bez zásahu aspoň začátek dokumentu (abstrakt, úvod), ať model může říct, o čem dokument je.
    if (!chosen.length) chosen = selectPassages(items, items, limit.found);
    const pages = [...new Set(chosen.map((p) => p.page).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);
    const shown = pages.slice(0, PAGES_SHOWN).join(', ') + (pages.length > PAGES_SHOWN ? '…' : '');
    step(t(pages.length ? 'chat.stepFound' : 'chat.stepFoundNoPages', { n: chosen.length, pages: shown }));
  }

  const recent = history.slice(-HISTORY).map((m) => ({ role: m.role, content: m.text.slice(0, HISTORY_CHARS) }));
  const messages = [{ role: 'system' as const, content: DOCUMENT_CHAT_SYSTEM + formatPassages(chosen) }, ...recent, { role: 'user' as const, content: question }];
  step(t('chat.stepWrite'));
  const raw = await answer(llm, messages, hooks);
  const { text, sources } = cleanCitations(raw, new Set(chosen.map((p) => p.id)));
  const reply: ChatMessage = { role: 'assistant', text: text || t('chat.noAnswer'), sources, whole, found: whole ? undefined : chosen.length, steps, ms: Date.now() - started, model: model?.name ?? model?.model, at: Date.now() };
  await store.saveChat(job.id, [...history, { role: 'user', text: question, at: Date.now() }, reply]);
  if (job.cost !== undefined) await store.saveJob(job);
  return reply;
}

/** Streamovaná odpověď; selže-li stream dřív než první token, spadne se na obyčejný dotaz. */
async function answer(llm: Llm, messages: Parameters<typeof ask>[2], hooks?: ChatHooks) {
  if (!hooks) return ask(llm, 'polish', messages, ANSWER_TOKENS);
  let pending: { content?: string; reasoning?: string } = {};
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  const flush = () => {
    timer = undefined;
    const d = pending;
    pending = {};
    if (d.content || d.reasoning) hooks.delta(d);
  };
  try {
    return await askStream(llm, 'polish', messages, ANSWER_TOKENS, (d) => {
      started = true;
      pending = { content: (pending.content ?? '') + (d.content ?? '') || undefined, reasoning: (pending.reasoning ?? '') + (d.reasoning ?? '') || undefined };
      timer ??= setTimeout(flush, FLUSH_MS);
    });
  } catch (e) {
    if (started) throw e;
    return ask(llm, 'polish', messages, ANSWER_TOKENS);
  } finally {
    clearTimeout(timer);
    flush();
  }
}
