import { t } from '../shared/i18n';
import { catalogRows } from '../shared/catalog-view';
import { FAST_REMOTE_MODEL, isOnline, RECOMMENDED_REMOTE_MODEL } from '../shared/provider';
import type { ChatMessage, ChatModel, Job, LmStatus, Segment, Settings } from '../shared/types';
import { cleanError, h, icon, ICONS } from './dom';

export interface ChatHost {
  segments(): Segment[];
  cite(segment: Segment): void;
}

const $ = (id: string) => document.getElementById(id)!;
const SNIPPET = 140;
const textOf = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? s.source;

let host: ChatHost;
let jobId: string | null = null;
let history: ChatMessage[] = [];
let pending: string | null = null;
interface Step {
  text: string;
  tags?: string[];
}
/** Průběh právě běžící odpovědi: kroky, psaný text a úvahy modelu. */
let run: { steps: Step[]; text: string; reasoning: string; started: number } | null = null;
let reasoningOpen = false;
let error = '';
let open = false;
let settings: Settings | null = null;
let localModels: LmStatus['models'] = [];
let remoteModels: LmStatus['models'] = [];
let hasKey = false;
let choice: ChatModel | null = null;
let closeMenu: (() => void) | null = null;

const MODEL_KEY = 'chatModel';
const MENU_ROWS = 30;

const nameOf = (c: { provider: ChatModel['provider']; model: string }) =>
  (c.provider === 'openrouter' ? remoteModels : localModels).find((m) => m.key === c.model)?.name ?? c.model;

/** Zvolený model s názvem; bez volby (nebo online bez klíče) polish aktivního poskytovatele. Volba se pamatuje jen v tomto počítači. */
function current(): ChatModel {
  if (!choice) {
    try {
      const saved = JSON.parse(localStorage.getItem(MODEL_KEY) ?? 'null') as ChatModel | null;
      if (saved && (saved.provider === 'local' || saved.provider === 'openrouter') && typeof saved.model === 'string') choice = saved;
    } catch {}
  }
  if (choice && (choice.provider === 'local' || hasKey)) return { ...choice, name: nameOf(choice) };
  // Online bez klíče by chat jen hlásil chybu, výchozí je pak model v počítači.
  const base =
    isOnline(settings ?? {}) && hasKey
      ? { provider: 'openrouter' as const, model: settings!.remoteModels.polish }
      : { provider: 'local' as const, model: settings!.models.polish };
  return { ...base, name: nameOf(base) };
}

function choose(c: ChatModel) {
  choice = { provider: c.provider, model: c.model };
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(choice));
  } catch {}
  closeMenu?.();
  renderModel();
  renderMessages();
}

const panel = () => $('chat-panel');
const send = () => ($('chat-send') as HTMLButtonElement);
const input = () => $('chat-input') as HTMLTextAreaElement;

/** Text odpovědi s citacemi [n] jako klikacími čipy; text modelu jde jen jako text node. */
function answerText(text: string, byId: Map<number, Segment>) {
  const box = h('div', { class: 'chat-text' });
  // Markdown z modelu: odrážky „* “/„- “ jako tečky, tučné ** bez hvězdiček.
  const plain = text.replace(/^(\s*)[*-]\s+/gm, '$1• ').replace(/\*\*(.+?)\*\*/g, '$1');
  plain.split(/\[(\d+)\]/).forEach((part, i) => {
    if (i % 2 === 0) return void (part && box.append(part));
    const segment = byId.get(Number(part));
    if (!segment) return void box.append(`[${part}]`);
    const title = `${t('chat.source', { n: part, page: segment.page ?? '–' })}: ${textOf(segment).slice(0, SNIPPET)}`;
    box.append(h('button', { class: 'cite-chip', title, onclick: () => host.cite(segment) }, part));
  });
  return box;
}

function stepsList(steps: Step[], active: boolean) {
  return h(
    'ul',
    { class: 'chat-steps' },
    ...steps.map((st, i) =>
      h(
        'li',
        { class: active && i === steps.length - 1 ? 'current' : 'done' },
        active && i === steps.length - 1 ? h('span', { class: 'chat-spin' }) : icon(ICONS.check),
        h('span', {}, st.text),
        !!st.tags?.length && h('span', { class: 'chat-tags' }, ...st.tags.map((tag) => h('span', { class: 'chat-tag' }, tag))),
      ),
    ),
  );
}

/** Sbalený průběh u hotové odpovědi: jeden řádek, po kliknutí kroky. */
function stepsSummary(m: ChatMessage) {
  if (!m.steps?.length) return null;
  const s = String(Math.max(1, Math.round((m.ms ?? 0) / 1000)));
  const label = m.whole || m.found === undefined ? t('chat.doneWhole', { s }) : t('chat.doneFound', { n: m.found, s });
  return h('details', { class: 'chat-done' }, h('summary', {}, label), stepsList(m.steps.map((text) => ({ text })), false));
}

/** Rozpracovaná odpověď; po dokončení ji nahradí finální zpráva s citacemi. */
function runEl() {
  if (!run) return null;
  const box = h('div', { class: 'chat-run' }, stepsList(run.steps, !run.text));
  if (run.reasoning) {
    const details = h('details', { class: 'chat-reasoning' }, h('summary', {}, t('chat.reasoning')), h('div', { class: 'chat-text muted' }, run.reasoning));
    details.open = reasoningOpen;
    details.addEventListener('toggle', () => (reasoningOpen = details.open));
    box.append(details);
  }
  if (run.text) box.append(h('div', { class: 'chat-text chat-stream' }, run.text));
  return box;
}

function messageEl(m: ChatMessage, byId: Map<number, Segment>) {
  if (m.role === 'user') return h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-text' }, m.text));
  return h('div', { class: 'chat-msg assistant' }, stepsSummary(m), answerText(m.text, byId), h('div', { class: 'chat-note' }, [m.whole ? t('chat.whole') : t('chat.found'), m.model].filter(Boolean).join(' · ')));
}

function renderMessages() {
  const byId = new Map(host.segments().map((s) => [s.id, s]));
  const list = $('chat-messages');
  list.replaceChildren(
    h('div', { class: 'chat-intro' }, h('p', {}, t('chat.intro')), h('p', { class: 'muted' }, t(settings && current().provider === 'openrouter' ? 'chat.online' : 'chat.private'))),
    ...history.map((m) => messageEl(m, byId)),
  );
  if (pending !== null) list.append(h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-text' }, pending)), runEl() ?? h('div', { class: 'chat-wait muted' }, t('chat.thinking')));
  if (error) list.append(h('div', { class: 'error-box' }, error));
  list.scrollTop = list.scrollHeight;
  const busy = pending !== null;
  send().disabled = busy;
  input().disabled = busy;
  for (const b of panel().querySelectorAll<HTMLButtonElement>('.chat-quick button, #chat-clear, .chat-model')) b.disabled = busy;
}

async function ask(question: string) {
  const id = jobId;
  question = question.trim();
  if (!id || !question || pending !== null) return;
  pending = question;
  run = { steps: [], text: '', reasoning: '', started: Date.now() };
  reasoningOpen = false;
  error = '';
  input().value = '';
  renderMessages();
  try {
    const answer = await window.api.askDocument(id, question, settings ? current() : undefined);
    if (jobId !== id) return;
    history.push({ role: 'user', text: question, at: Date.now() }, answer);
  } catch (e) {
    if (jobId !== id) return;
    error = cleanError(e);
    input().value = question;
  }
  pending = null;
  run = null;
  renderMessages();
  input().focus();
}

const chipLabel = (c: ChatModel) => `${t(c.provider === 'openrouter' ? 'chat.modelOnline' : 'chat.modelLocal')} · ${c.name}`;

/** Čip modelu a poznámka pod polem; po změně volby nebo načtení modelů. */
function renderModel() {
  const el = document.getElementById('chat-model');
  if (!el || !settings) return;
  const c = current();
  const online = c.provider === 'openrouter';
  el.replaceChildren(icon(online ? ICONS.globe : ICONS.lock), h('span', { class: 'chat-model-name' }, chipLabel(c)), icon(ICONS.chevron));
  $('chat-privacy').textContent = t(online ? 'chat.noteOnline' : 'chat.noteLocal');
}

function modelMenu(anchor: HTMLElement) {
  const menu = h('div', { class: 'chat-menu', role: 'menu' });
  const selected = current();
  const item = (c: ChatModel) =>
    h(
      'button',
      { class: 'chat-menu-item', role: 'menuitemradio', 'aria-checked': String(c.provider === selected.provider && c.model === selected.model), onclick: () => choose(c) },
      h('span', {}, c.name ?? c.model),
      c.provider === selected.provider && c.model === selected.model && icon(ICONS.check),
    );
  const label = (text: string) => h('div', { class: 'chat-menu-label' }, text);
  const hint = (text: string) => h('div', { class: 'chat-menu-hint' }, text);

  const polish = settings!.models.polish;
  // OCR a TranslateGemma neumí volný chat.
  const locals = localModels.filter((m) => !/ocr|translategemma|embed/i.test(`${m.key} ${m.name}`)).sort((a, b) => Number(b.key === polish) - Number(a.key === polish));
  const quick = [...new Set([settings!.remoteModels.polish, RECOMMENDED_REMOTE_MODEL, FAST_REMOTE_MODEL])];

  const showSearch = () => {
    const list = h('div', { class: 'chat-menu-list' });
    const field = h('input', { type: 'search', class: 'chat-menu-search', placeholder: t('chat.modelSearch') });
    const fill = () => {
      const { rows } = catalogRows(remoteModels, { text: field.value, visionOnly: false }, MENU_ROWS);
      list.replaceChildren(...rows.map((m) => item({ provider: 'openrouter', model: m.key, name: m.name })));
    };
    field.addEventListener('input', fill);
    menu.replaceChildren(field, list);
    fill();
    field.focus();
  };

  menu.append(
    label(t('chat.modelLocal')),
    ...(locals.length ? locals.map((m) => item({ provider: 'local', model: m.key, name: m.name })) : [hint(t('chat.modelNone'))]),
    label(t('chat.modelOnline')),
    ...(hasKey
      ? [...quick.map((key) => item({ provider: 'openrouter', model: key, name: nameOf({ provider: 'openrouter', model: key }) })), h('button', { class: 'chat-menu-item more', onclick: showSearch }, h('span', {}, t('chat.modelMore')))]
      : [hint(t('chat.modelNoKey'))]),
  );
  anchor.append(menu);
  return menu;
}

function toggleMenu(anchor: HTMLElement) {
  if (closeMenu) return closeMenu();
  const menu = modelMenu(anchor);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), closeMenu?.());
  const onDown = (e: MouseEvent) => {
    if (!anchor.contains(e.target as Node)) closeMenu?.();
  };
  closeMenu = () => {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    closeMenu = null;
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
}

function buildPanel() {
  closeMenu?.();
  const quick = (label: 'chat.summary' | 'chat.keyPoints', prompt: 'chat.summaryPrompt' | 'chat.keyPointsPrompt') => h('button', { class: 'btn', onclick: () => void ask(t(prompt)) }, t(label));
  const field = h('textarea', { id: 'chat-input', rows: '2', placeholder: t('chat.placeholder') });
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void ask(field.value);
  });
  $('chat-inner').replaceChildren(
    h(
      'div',
      { class: 'chat-head' },
      h('strong', {}, t('chat.tab')),
      h(
        'button',
        {
          id: 'chat-clear',
          class: 'btn',
          title: t('chat.clear'),
          'aria-label': t('chat.clear'),
          onclick: async () => {
            if (!jobId) return;
            await window.api.clearChat(jobId);
            history = [];
            error = '';
            renderMessages();
          },
        },
        icon(ICONS.trash),
      ),
      h('button', { class: 'btn', title: t('chat.hide'), 'aria-label': t('chat.hide'), onclick: () => setOpen(false) }, icon(ICONS.collapse)),
    ),
    h('div', { class: 'chat-messages', id: 'chat-messages' }),
    h('div', { class: 'chat-quick' }, quick('chat.summary', 'chat.summaryPrompt'), quick('chat.keyPoints', 'chat.keyPointsPrompt')),
    h(
      'div',
      { class: 'chat-form' },
      field,
      h(
        'div',
        { class: 'chat-controls' },
        h('button', { id: 'chat-model', class: 'chat-model', title: t('chat.modelPick'), 'aria-label': t('chat.modelPick'), 'aria-haspopup': 'menu', onclick: (e: Event) => toggleMenu((e.currentTarget as HTMLElement).closest('.chat-form') as HTMLElement) }),
        h('span', { id: 'chat-privacy', class: 'chat-privacy muted' }),
        h('button', { id: 'chat-send', class: 'chat-send', title: t('chat.send'), 'aria-label': t('chat.send'), onclick: () => void ask(field.value) }, icon(ICONS.up)),
      ),
    ),
  );
}

async function load() {
  const id = jobId;
  if (!id || !open) return;
  history = [];
  pending = null;
  run = null;
  error = '';
  try {
    const [messages, s, local, remote] = await Promise.all([
      window.api.jobChat(id),
      window.api.getSettings(),
      window.api.lmStatus('local').catch(() => null),
      window.api.lmStatus('openrouter').catch(() => null),
    ]);
    if (jobId !== id) return;
    history = messages;
    settings = s;
    localModels = local?.models ?? [];
    remoteModels = remote?.models ?? [];
    hasKey = Boolean(remote?.hasKey);
  } catch (e) {
    error = cleanError(e);
  }
  renderMessages();
  renderModel();
}

// Zavřený chat v detailu úlohy zůstane jako úzká lišta u pravého okraje.
function syncRail() {
  $('chat-rail').hidden = open || jobId === null;
  const bar = $('chat-bar');
  bar.hidden = jobId === null;
  bar.classList.toggle('active', open);
  bar.title = t(open ? 'chat.hide' : 'chat.show');
  bar.setAttribute('aria-label', bar.title);
}

function setOpen(value: boolean) {
  open = value;
  panel().hidden = !open;
  syncRail();
  if (open) {
    buildPanel();
    void load();
  }
}

/** Panel se otevře až na žádost, historie se načte pro aktuální úlohu. */
export function showChat(job: Job) {
  if (jobId === job.id) return;
  jobId = job.id;
  syncRail();
  void load();
}

/** Mimo detail úlohy se panel zavře. */
export function resetChat() {
  jobId = null;
  if (open) setOpen(false);
  syncRail();
}

const WIDTH_KEY = 'chatWidth';
const MIN_WIDTH = 300;
// Tažením užším než tohle se chat zasune do lišty.
const CLOSE_WIDTH = 200;

function setWidth(px: number) {
  panel().style.setProperty('--chat-width', `${Math.round(px)}px`);
}

/** Šířka panelu tažením za levý okraj; pamatuje si ji jen tento počítač. */
function setupResize() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved >= MIN_WIDTH) setWidth(saved);
  } catch {}
  const handle = $('chat-resize');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const right = panel().getBoundingClientRect().right;
    handle.classList.add('dragging');
    let closing = false;
    const move = (ev: MouseEvent) => {
      closing = right - ev.clientX < CLOSE_WIDTH;
      panel().classList.toggle('closing', closing);
      setWidth(Math.min(window.innerWidth / 2, Math.max(MIN_WIDTH, right - ev.clientX)));
    };
    const up = () => {
      handle.classList.remove('dragging');
      panel().classList.remove('closing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (closing) return setOpen(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(panel().getBoundingClientRect().width));
      } catch {}
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

export function setupChat(chatHost: ChatHost) {
  host = chatHost;
  window.api.onChatProgress((p) => {
    if (!run || p.jobId !== jobId) return;
    run.steps.push({ text: p.step, tags: p.tags });
    renderMessages();
  });
  window.api.onChatDelta((d) => {
    if (!run || d.jobId !== jobId) return;
    run.text += d.content ?? '';
    run.reasoning += d.reasoning ?? '';
    renderMessages();
  });
  $('chat-rail').addEventListener('click', () => setOpen(true));
  $('chat-bar').addEventListener('click', () => setOpen(!open));
  setupResize();
}
