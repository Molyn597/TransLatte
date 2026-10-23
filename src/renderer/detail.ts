import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import { locale, t, type MessageKey } from '../shared/i18n';
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

type Tab = 'compare' | 'translated-pdf' | 'side-by-side' | 'translation' | 'original' | 'info';

const $ = (id: string) => document.getElementById(id)!;
const finalText = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? '';
// Citáty jen pro přeložené PDF se ve Srovnání ani v Překladu nezobrazují.
const visible = (segments: Segment[]) => segments.filter((s) => !s.layoutOnly);
const GENDER: Record<DocumentContext['authorGender'], MessageKey> = {
  female: 'detail.gender.female',
  male: 'detail.gender.male',
  unknown: 'detail.gender.unknown',
};
// Fáze ze starších úloh (celotextové uhlazení), aby jejich doba měla v Informacích popisek.
const OLD_STAGES: Record<string, MessageKey> = { polish: 'stage.polish', glossary: 'stage.glossary' };

let current: JobDetail | null = null;
let tab: Tab = 'compare';
let renderToken = 0;

export const detailJobId = () => current?.job.id ?? null;
const pdfTabs = () => document.querySelectorAll<HTMLButtonElement>('#detail-tabs .tab[data-pdf]');
// Pod touto šířkou těla se stránky řadí pod sebe.
const SIDE_BY_SIDE_MIN = 760;
const PAIR_GAP = 14;

function meta(job: Job) {
  const chips = [
    h('span', { class: job.status === 'error' ? 'chip err' : 'chip' }, t(STATUS_TEXT[job.status])),
    h('span', { class: 'chip' }, t(MODES[job.mode].title)),
    h('span', { class: 'chip' }, langPair(job)),
    h('span', { class: 'chip' }, date(job.createdAt)),
  ];
  if (job.pages) chips.push(h('span', { class: 'chip' }, t('detail.pages', { count: job.pages })));
  if (jobDuration(job)) chips.push(h('span', { class: 'chip' }, jobDuration(job)));
  if (job.warnings) chips.push(h('span', { class: 'chip warn' }, t('job.warnings', { count: job.warnings })));
  return chips;
}

function relayoutButton(job: Job) {
  const button = h('button', { class: 'btn' }, icon(ICONS.retry), t('detail.relayout'));
  button.onclick = async () => {
    button.disabled = true;
    try {
      await window.api.relayoutJob(job.id);
      toast(t('detail.relayoutDone'));
      await openDetail(job.id, tab);
    } finally {
      button.disabled = false;
    }
  };
  return button;
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
            toast(t('detail.retryQueued', { name: job.name, mode: t(MODES[mode].title) }));
          },
        },
        t('mode.suffix', { mode: t(MODES[mode].title) }),
      ),
    );
  }
  const button = h('button', { class: 'btn', onclick: (e: Event) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  } }, icon(ICONS.retry), t('detail.retry'));
  wrap.append(button, menu);
  return wrap;
}

function actions(job: Job) {
  const list: HTMLElement[] = [];
  if (job.status === 'running' || job.status === 'queued') {
    list.push(h('button', { class: 'btn danger', onclick: () => window.api.cancelJob(job.id) }, icon(ICONS.stop), t('job.cancel')));
    return list;
  }
  if (job.status === 'done') {
    if (job.outputPdf) {
      list.push(h('button', { class: 'btn primary', onclick: () => window.api.openOutput(job.id, 'pdf') }, icon(ICONS.file), t('detail.openPdf')));
    }
    list.push(
      h('button', { class: job.outputPdf ? 'btn' : 'btn primary', onclick: () => window.api.openOutput(job.id, 'docx') }, icon(ICONS.file), t('detail.openWord')),
      h('button', { class: 'btn', onclick: () => window.api.saveOutputAs(job.id) }, icon(ICONS.download), t('detail.saveAs')),
      h('button', { class: 'btn', onclick: () => window.api.revealOutput(job.id) }, icon(ICONS.folder), t('detail.reveal')),
    );
  }
  if (job.status === 'done' && job.ext.toLowerCase() === '.pdf') list.push(relayoutButton(job));
  list.push(retryMenu(job));
  list.push(
    h(
      'button',
      {
        class: 'btn danger',
        title: t('detail.delete'),
        onclick: async () => {
          if (!confirm(t('detail.confirmDelete', { name: job.name }))) return;
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
    h('div', { class: 'compare-head' }, t('detail.originalLang', { lang: languageName(current!.job.sourceLang) })),
    h('div', { class: 'compare-head' }, t('detail.translationLang', { lang: languageName(current!.job.targetLang) })),
  );
  let page: number | undefined;
  for (const s of segments) {
    if (s.page && s.page !== page && segments.some((x) => x.page && x.page > 1)) {
      page = s.page;
      grid.append(h('div', { class: 'compare-page' }, t('detail.page', { page })));
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
    const body = text(s);
    if (s.kind === 'heading') doc.append(h('h2', {}, body));
    else if (s.kind === 'list') {
      const ul = h('ul');
      for (const li of body.split('\n').filter((l) => l.trim())) ul.append(h('li', {}, li.replace(/^\s*([-*•–]|\d+[.)])\s+/, '')));
      doc.append(ul);
    } else if (s.kind === 'table') doc.append(tableEl(body));
    else doc.append(h('p', {}, body));
  }
  return doc;
}

async function originalView(detail: JobDetail, token: number) {
  if (detail.job.ext !== '.pdf') return documentView(visible(detail.segments), (s) => s.source);
  return pdfView(await window.api.readInput(detail.job.id), token);
}

async function pdfCanvas(pdf: PDFDocumentProxy, number: number, width: number) {
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (width / base.width) * window.devicePixelRatio });
  const canvas = h('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${width}px`;
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

async function pdfView(data: Uint8Array | null, token: number) {
  const holder = h('div', { class: 'pdf-pages' }, h('p', { class: 'muted' }, t('detail.loadingPdf')));
  if (!data || token !== renderToken) return holder;
  const pdf = await getDocument({ data, ...PDFJS_OPTIONS }).promise;
  holder.replaceChildren();
  const width = Math.min(900, $('detail-body').clientWidth || 800);
  for (let p = 1; p <= pdf.numPages; p++) {
    if (token !== renderToken) break;
    holder.append(await pdfCanvas(pdf, p, width));
  }
  return holder;
}

/** Stránka originálu a téže stránky překladu vedle sebe; v úzkém okně pod sebou. */
async function sideBySideView(detail: JobDetail, token: number) {
  const holder = h('div', { class: 'pdf-pages pdf-pairs' });
  const [source, output] = await Promise.all([window.api.readInput(detail.job.id), window.api.readOutputPdf(detail.job.id)]);
  if (!source || !output || token !== renderToken) return holder;
  const [left, right] = await Promise.all([getDocument({ data: source, ...PDFJS_OPTIONS }).promise, getDocument({ data: output, ...PDFJS_OPTIONS }).promise]);
  const available = $('detail-body').clientWidth || 800;
  const stacked = available < SIDE_BY_SIDE_MIN;
  const width = stacked ? Math.min(900, available) : Math.floor((available - PAIR_GAP) / 2);
  holder.classList.toggle('stacked', stacked);
  for (let p = 1; p <= Math.max(left.numPages, right.numPages); p++) {
    if (token !== renderToken) break;
    const pair = h('div', { class: 'pdf-pair' });
    holder.append(pair);
    const cells = await Promise.all([p <= left.numPages ? pdfCanvas(left, p, width) : null, p <= right.numPages ? pdfCanvas(right, p, width) : null]);
    for (const canvas of cells) pair.append(canvas ?? h('div'));
  }
  return holder;
}

const stageName = (stage: string) => {
  const key = STAGES[stage as Stage] ?? OLD_STAGES[stage];
  return key ? t(key) : stage;
};

function infoView(detail: JobDetail) {
  const { job, segments } = detail;
  const dl = h('dl', { class: 'info' });
  const row = (k: string, v: string) => dl.append(h('dt', {}, k), h('dd', {}, v));
  row(t('detail.info.file'), `${job.name}${job.ext}`);
  row(t('detail.info.status'), t(STATUS_TEXT[job.status]));
  row(t('detail.info.mode'), `${t(MODES[job.mode].title)} – ${t(MODES[job.mode].desc)}`);
  row(t('detail.info.languages'), langPair(job));
  row(t('detail.info.created'), date(job.createdAt));
  if (jobDuration(job)) row(t('detail.info.duration'), jobDuration(job));
  if (job.pages) row(t('detail.info.pages'), job.pageRange ? t('detail.info.pagesSelection', { pages: job.pages, range: job.pageRange }) : String(job.pages));
  if (job.chars) row(t('detail.info.chars'), job.chars.toLocaleString(locale()));
  row(t('detail.info.paragraphs'), String(visible(segments).length));
  if (job.output) row(t('detail.info.output'), job.outputPdf ? `${job.output}, ${job.outputPdf}` : job.output);
  if (job.context) {
    const c = job.context;
    row(
      t('detail.info.context'),
      t('detail.info.contextText', {
        topic: c.topic || t('detail.info.noTopic'),
        author: c.author || t('detail.info.noAuthor'),
        gender: t(GENDER[c.authorGender]),
      }),
    );
  }
  if (job.notes?.length) row(t('detail.info.notes'), job.notes.join(' '));
  const timings = Object.entries(job.timings ?? {}).filter(([, s]) => s >= 1);
  if (timings.length) {
    row(
      t('detail.info.stages'),
      timings.map(([stage, s]) => `${stageName(stage)}: ${duration(s)}`).join(' · '),
    );
  }
  const box = h('div', { class: 'view' }, dl);
  if (job.error) box.prepend(h('div', { class: 'error-box' }, job.error));
  const warned = segments.filter((s) => s.warning);
  if (warned.length) {
    const list = h('ul');
    for (const s of warned) list.append(h('li', {}, s.page ? t('detail.info.warningPage', { page: s.page, text: s.warning! }) : s.warning!));
    box.append(h('div', { class: 'setting-group' }, h('h2', {}, t('detail.info.warnings')), list));
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
  if (tab === 'original' || tab === 'translated-pdf' || tab === 'side-by-side') {
    body.replaceChildren(h('p', { class: 'muted' }, t('detail.loading')));
    try {
      const view =
        tab === 'original'
          ? await originalView(current, token)
          : tab === 'side-by-side'
            ? await sideBySideView(current, token)
            : await pdfView(await window.api.readOutputPdf(job.id), token);
      if (token === renderToken) body.replaceChildren(view);
    } catch (e) {
      const what = tab === 'original' ? 'detail.tab.original' : tab === 'side-by-side' ? 'detail.tab.sideBySide' : 'detail.translatedPdf';
      if (token === renderToken) body.replaceChildren(h('div', { class: 'error-box' }, t('detail.cannotShow', { what: t(what), error: (e as Error).message })));
    }
    return;
  }
  if (!segments.length) {
    const text =
      job.status === 'done' ? t('detail.noText') : job.status === 'error' ? (job.error ?? t('status.error')) : t('detail.pending');
    return body.replaceChildren(h('p', { class: job.status === 'error' ? 'error-box' : 'empty' }, text));
  }
  body.replaceChildren(tab === 'compare' ? compareView(visible(segments)) : documentView(visible(segments), finalText));
}

function renderHeader() {
  if (!current) return;
  const { job } = current;
  $('detail-name').textContent = job.name;
  $('detail-meta').replaceChildren(...meta(job));
  $('detail-actions').replaceChildren(...actions(job));
  for (const b of pdfTabs()) b.hidden = !job.outputPdf;
  if ((tab === 'translated-pdf' || tab === 'side-by-side') && !job.outputPdf) tab = 'compare';
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
