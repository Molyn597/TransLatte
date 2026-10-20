import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { languageName } from '../shared/languages';
import { PDFJS_OPTIONS } from '../shared/pdf';
import type { DocumentContext, Job, JobDetail, Mode, Segment, Stage } from '../shared/types';
import {
  date,
  duration,
  h,
  icon,
  ICONS,
  jobDuration,
  langPair,
  MODES,
  progressBar,
  progressInfo,
  STAGES,
  STATUS_TEXT,
  toast,
} from './dom';

GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

type Tab = 'compare' | 'translation' | 'original' | 'info';

const $ = (id: string) => document.getElementById(id)!;
const finalText = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? '';
const GENDER: Record<DocumentContext['authorGender'], string> = { female: 'žena', male: 'muž', unknown: 'rod neznámý' };
// Fáze ze starších úloh (celotextové uhlazení), aby jejich doba měla v Informacích popisek.
const OLD_STAGES: Record<string, string> = { polish: 'Uhlazuji text', glossary: 'Kontroluji glosář' };

let current: JobDetail | null = null;
let tab: Tab = 'compare';
let renderToken = 0;

export const detailJobId = () => current?.job.id ?? null;

function meta(job: Job) {
  const chips = [
    h('span', { class: job.status === 'error' ? 'chip err' : 'chip' }, STATUS_TEXT[job.status]),
    h('span', { class: 'chip' }, MODES[job.mode].title),
    h('span', { class: 'chip' }, langPair(job)),
    h('span', { class: 'chip' }, date(job.createdAt)),
  ];
  if (job.pages) chips.push(h('span', { class: 'chip' }, `${job.pages} str.`));
  if (jobDuration(job)) chips.push(h('span', { class: 'chip' }, jobDuration(job)));
  if (job.warnings) chips.push(h('span', { class: 'chip warn' }, `${job.warnings}× upozornění`));
  return chips;
}

function retryMenu(job: Job) {
  const wrap = h('div', { class: 'menu-wrap' });
  const menu = h('div', { class: 'menu', hidden: true });
  for (const mode of Object.keys(MODES) as Mode[]) {
    menu.append(
      h(
        'button',
        {
          onclick: async () => {
            menu.hidden = true;
            await window.api.retryJob(job.id, mode);
            toast(`Přidáno do fronty: ${job.name} (${MODES[mode].title})`);
          },
        },
        `${MODES[mode].title} režim`,
      ),
    );
  }
  const button = h('button', { class: 'btn', onclick: (e: Event) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  } }, icon(ICONS.retry), 'Přeložit znovu');
  wrap.append(button, menu);
  return wrap;
}

function actions(job: Job) {
  const list: HTMLElement[] = [];
  if (job.status === 'running' || job.status === 'queued') {
    list.push(h('button', { class: 'btn danger', onclick: () => window.api.cancelJob(job.id) }, icon(ICONS.stop), 'Zrušit'));
    return list;
  }
  if (job.status === 'done') {
    list.push(
      h('button', { class: 'btn primary', onclick: () => window.api.openOutput(job.id) }, icon(ICONS.file), 'Otevřít Word'),
      h('button', { class: 'btn', onclick: () => window.api.saveOutputAs(job.id) }, icon(ICONS.download), 'Uložit jako…'),
      h('button', { class: 'btn', onclick: () => window.api.revealOutput(job.id) }, icon(ICONS.folder), 'Ve složce'),
    );
  }
  list.push(retryMenu(job));
  list.push(
    h(
      'button',
      {
        class: 'btn danger',
        title: 'Smazat z historie',
        onclick: async () => {
          if (!confirm(`Smazat „${job.name}“ z historie včetně přeloženého souboru?`)) return;
          await window.api.deleteJob(job.id);
        },
      },
      icon(ICONS.trash),
    ),
  );
  return list;
}

function renderProgress(job: Job) {
  const box = $('detail-progress');
  const running = job.status === 'running' || job.status === 'queued';
  box.hidden = !running;
  if (!running) return;
  const info = progressInfo(job);
  box.replaceChildren(
    h('div', { class: 'row gap' }, h('strong', {}, info.label), h('span', { class: 'muted' }, info.eta)),
    progressBar(info.fraction),
  );
}

function compareView(segments: Segment[]) {
  const grid = h(
    'div',
    { class: 'compare' },
    h('div', { class: 'compare-head' }, `Originál (${languageName(current!.job.sourceLang)})`),
    h('div', { class: 'compare-head' }, `Překlad (${languageName(current!.job.targetLang)})`),
  );
  let page: number | undefined;
  for (const s of segments) {
    if (s.page && s.page !== page && segments.some((x) => x.page && x.page > 1)) {
      page = s.page;
      grid.append(h('div', { class: 'compare-page' }, `Stránka ${page}`));
    }
    const cls = `compare-cell${s.kind === 'heading' ? ' heading' : ''}${s.warning ? ' has-warning' : ''}`;
    grid.append(
      h('div', { class: cls }, s.source),
      h('div', { class: cls }, finalText(s) || '…', s.warning ? h('span', { class: 'warning-note' }, `⚠ ${s.warning}`) : null),
    );
  }
  return grid;
}

function tableEl(text: string) {
  const table = h('table');
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|') || /^\|[\s|:-]+\|$/.test(line.trim())) continue;
    const row = h('tr');
    for (const cell of line.trim().replace(/^\||\|$/g, '').split('|')) row.append(h('td', {}, cell.trim()));
    table.append(row);
  }
  return table;
}

function documentView(segments: Segment[], text: (s: Segment) => string) {
  const doc = h('article', { class: 'doc' });
  for (const s of segments) {
    const t = text(s);
    if (s.kind === 'heading') doc.append(h('h2', {}, t));
    else if (s.kind === 'list') {
      const ul = h('ul');
      for (const li of t.split('\n').filter((l) => l.trim())) ul.append(h('li', {}, li.replace(/^\s*([-*•–]|\d+[.)])\s+/, '')));
      doc.append(ul);
    } else if (s.kind === 'table') doc.append(tableEl(t));
    else doc.append(h('p', {}, t));
  }
  return doc;
}

async function originalView(detail: JobDetail, token: number) {
  if (detail.job.ext !== '.pdf') return documentView(detail.segments, (s) => s.source);
  const holder = h('div', { class: 'pdf-pages' }, h('p', { class: 'muted' }, 'Načítám PDF…'));
  const data = await window.api.readInput(detail.job.id);
  if (!data || token !== renderToken) return holder;
  const pdf = await getDocument({ data, ...PDFJS_OPTIONS }).promise;
  holder.replaceChildren();
  const width = Math.min(900, $('detail-body').clientWidth || 800);
  for (let p = 1; p <= pdf.numPages; p++) {
    if (token !== renderToken) break;
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * window.devicePixelRatio });
    const canvas = h('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${width}px`;
    holder.append(canvas);
    await page.render({ canvas, viewport }).promise;
  }
  return holder;
}

function infoView(detail: JobDetail) {
  const { job, segments } = detail;
  const dl = h('dl', { class: 'info' });
  const row = (k: string, v: string) => dl.append(h('dt', {}, k), h('dd', {}, v));
  row('Soubor', `${job.name}${job.ext}`);
  row('Stav', STATUS_TEXT[job.status]);
  row('Režim', `${MODES[job.mode].title} – ${MODES[job.mode].desc}`);
  row('Jazyky', langPair(job));
  row('Vytvořeno', date(job.createdAt));
  if (jobDuration(job)) row('Doba zpracování', jobDuration(job));
  if (job.pages) row('Stránek', job.pageRange ? `${job.pages} (výběr ${job.pageRange})` : String(job.pages));
  if (job.chars) row('Znaků originálu', job.chars.toLocaleString('cs-CZ'));
  row('Odstavců', String(segments.length));
  if (job.output) row('Výstup', job.output);
  if (job.context) {
    const c = job.context;
    row('Kontext dokumentu', `${c.topic || 'téma neuvedeno'}; autor: ${c.author || 'neuveden'} (${GENDER[c.authorGender]})`);
  }
  if (job.notes?.length) row('Poznámky', job.notes.join(' '));
  const timings = Object.entries(job.timings ?? {}).filter(([, s]) => s >= 1);
  if (timings.length) {
    row('Fáze', timings.map(([stage, s]) => `${STAGES[stage as Stage] ?? OLD_STAGES[stage] ?? stage}: ${duration(s)}`).join(' · '));
  }
  const box = h('div', { class: 'view' }, dl);
  if (job.error) box.prepend(h('div', { class: 'error-box' }, job.error));
  const warned = segments.filter((s) => s.warning);
  if (warned.length) {
    const list = h('ul');
    for (const s of warned) list.append(h('li', {}, `${s.page ? `Str. ${s.page}: ` : ''}${s.warning}`));
    box.append(h('div', { class: 'setting-group' }, h('h2', {}, 'Upozornění'), list));
  }
  return box;
}

async function renderBody() {
  if (!current) return;
  const token = ++renderToken;
  const body = $('detail-body');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#detail-tabs .tab')) {
    b.classList.toggle('active', b.dataset.tab === tab);
  }
  const { job, segments } = current;
  if (tab === 'info') return body.replaceChildren(infoView(current));
  if (tab === 'original') {
    body.replaceChildren(h('p', { class: 'muted' }, 'Načítám…'));
    try {
      const view = await originalView(current, token);
      if (token === renderToken) body.replaceChildren(view);
    } catch (e) {
      if (token === renderToken) body.replaceChildren(h('div', { class: 'error-box' }, `Originál nejde zobrazit: ${(e as Error).message}`));
    }
    return;
  }
  if (!segments.length) {
    const text =
      job.status === 'done' ? 'Dokument neobsahuje žádný text.' : job.status === 'error' ? job.error ?? 'Chyba' : 'Výsledek se objeví, až překlad doběhne.';
    return body.replaceChildren(h('p', { class: job.status === 'error' ? 'error-box' : 'empty' }, text));
  }
  body.replaceChildren(tab === 'compare' ? compareView(segments) : documentView(segments, finalText));
}

function renderHeader() {
  if (!current) return;
  const { job } = current;
  $('detail-name').textContent = job.name;
  $('detail-meta').replaceChildren(...meta(job));
  $('detail-actions').replaceChildren(...actions(job));
  renderProgress(job);
}

export async function openDetail(id: string, initialTab: Tab = 'compare') {
  const detail = await window.api.getJob(id);
  if (!detail) return false;
  current = detail;
  tab = initialTab;
  renderHeader();
  await renderBody();
  return true;
}

/** Živá aktualizace: hlavička hned, obsah až po dokončení (segmenty se ukládají na konci). */
export async function updateDetail(job: Job) {
  if (!current || current.job.id !== job.id) return;
  const finished = current.job.status !== job.status && !['running', 'queued'].includes(job.status);
  current.job = job;
  renderHeader();
  if (finished) {
    const detail = await window.api.getJob(job.id);
    if (detail) current = detail;
    renderHeader();
    await renderBody();
  }
}

export function setupDetail(onBack: () => void) {
  $('detail-back').addEventListener('click', onBack);
  document.addEventListener('click', () => {
    for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('#detail-tabs .tab')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab;
      void renderBody();
    });
  }
}

export function closeDetail() {
  current = null;
  renderToken++;
}
