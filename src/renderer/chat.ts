import { t } from '../shared/i18n';
import { isOnline } from '../shared/provider';
import type { ChatMessage, Job, Segment } from '../shared/types';
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
let error = '';
let online = false;
let open = false;

const panel = () => $('chat-panel');
const send = () => ($('chat-send') as HTMLButtonElement);
const input = () => $('chat-input') as HTMLTextAreaElement;

/** Text odpovědi s citacemi [n] jako klikacími čipy; text modelu jde jen jako text node. */
function answerText(text: string, byId: Map<number, Segment>) {
  const box = h('div', { class: 'chat-text' });
  text.split(/\[(\d+)\]/).forEach((part, i) => {
    if (i % 2 === 0) return void (part && box.append(part));
    const segment = byId.get(Number(part));
    if (!segment) return void box.append(`[${part}]`);
    const title = `${t('chat.source', { n: part, page: segment.page ?? '–' })}: ${textOf(segment).slice(0, SNIPPET)}`;
    box.append(h('button', { class: 'cite-chip', title, onclick: () => host.cite(segment) }, part));
  });
  return box;
}

function messageEl(m: ChatMessage, byId: Map<number, Segment>) {
  if (m.role === 'user') return h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-text' }, m.text));
  return h('div', { class: 'chat-msg assistant' }, answerText(m.text, byId), h('div', { class: 'chat-note' }, m.whole ? t('chat.whole') : t('chat.found')));
}

function renderMessages() {
  const byId = new Map(host.segments().map((s) => [s.id, s]));
  const list = $('chat-messages');
  list.replaceChildren(
    h('div', { class: 'chat-intro' }, h('p', {}, t('chat.intro')), h('p', { class: 'muted' }, t(online ? 'chat.online' : 'chat.private'))),
    ...history.map((m) => messageEl(m, byId)),
  );
  if (pending !== null) list.append(h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-text' }, pending)), h('div', { class: 'chat-wait muted' }, t('chat.thinking'), h('span', { class: 'chat-wait-note' }, t('chat.wait'))));
  if (error) list.append(h('div', { class: 'error-box' }, error));
  list.scrollTop = list.scrollHeight;
  const busy = pending !== null;
  send().disabled = busy;
  input().disabled = busy;
  for (const b of panel().querySelectorAll<HTMLButtonElement>('.chat-quick button, #chat-clear')) b.disabled = busy;
}

async function ask(question: string) {
  const id = jobId;
  question = question.trim();
  if (!id || !question || pending !== null) return;
  pending = question;
  error = '';
  input().value = '';
  renderMessages();
  try {
    const answer = await window.api.askDocument(id, question);
    if (jobId !== id) return;
    history.push({ role: 'user', text: question, at: Date.now() }, answer);
  } catch (e) {
    if (jobId !== id) return;
    error = cleanError(e);
    input().value = question;
  }
  pending = null;
  renderMessages();
  input().focus();
}

function buildPanel() {
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
    h('div', { class: 'chat-form' }, field, h('button', { id: 'chat-send', class: 'btn primary', onclick: () => void ask(field.value) }, t('chat.send'))),
  );
}

async function load() {
  const id = jobId;
  if (!id || !open) return;
  history = [];
  pending = null;
  error = '';
  try {
    const [messages, settings] = await Promise.all([window.api.jobChat(id), window.api.getSettings()]);
    if (jobId !== id) return;
    history = messages;
    online = isOnline(settings);
  } catch (e) {
    error = cleanError(e);
  }
  renderMessages();
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
  $('chat-toggle').classList.toggle('active', open);
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
  $('chat-toggle').addEventListener('click', () => setOpen(!open));
  $('chat-rail').addEventListener('click', () => setOpen(true));
  $('chat-bar').addEventListener('click', () => setOpen(!open));
  setupResize();
}
