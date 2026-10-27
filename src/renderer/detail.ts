import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import { formatUsd } from '../shared/estimate';
import { locale, t, type MessageKey } from '../shared/i18n';
import { languageName } from '../shared/languages';
import { PDFJS_OPTIONS } from '../shared/pdf';
import { isOnline } from '../shared/provider';
import { findRegion, normalizeCrop } from '../shared/regions';
import type { DocumentContext, Job, JobDetail, Mode, RegionTranslation, Segment, Stage } from '../shared/types';
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
const pickable = (segments: Segment[]) => segments.filter((s) => !s.layoutOnly && !s.figure);
const isPicking = () => current?.job.status === 'picking' || picking;
const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
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
// Výběr odstavců u hotové úlohy (u stavu picking se výběr ukazuje vždy).
let picking = false;
let picked = new Set<number>();
let regions: RegionTranslation[] = [];
// Vrstvy stránek originálu podle čísla stránky, aby šel přidat rámeček bez překreslení.
let regionLayers = new Map<number, HTMLElement[]>();

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
  if (isOnline(job)) chips.push(h('span', { class: 'chip' }, t('job.online')));
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
  if (job.status === 'picking') {
    list.push(retryMenu(job), deleteButton(job));
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
  if (job.status === 'done' && current && pickable(current.segments).some((s) => s.skipped)) list.push(moreButton());
  list.push(retryMenu(job), deleteButton(job));
  return list;
}

function deleteButton(job: Job) {
  return h(
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
  );
}

function moreButton() {
  return h(
    'button',
    {
      class: 'btn',
      onclick: () => {
        startPicking();
        tab = 'compare';
        void renderBody();
      },
    },
    icon(ICONS.list),
    t('pick.more'),
  );
}

/** Výchozí výběr: u nové úlohy vše, u hotové jen to, co už je přeložené (to je zamčené). */
function startPicking() {
  picking = true;
  const segments = pickable(current!.segments);
  picked = new Set(segments.filter((s) => current!.job.status === 'picking' || s.translation !== undefined).map((s) => s.id));
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
    const cls = `compare-cell${s.kind === 'heading' ? ' heading' : ''}${s.warning ? ' has-warning' : ''}${s.skipped ? ' skipped' : ''}`;
    grid.append(
      h('div', { class: cls }, s.source),
      h('div', { class: cls }, s.skipped ? t('detail.skipped') : finalText(s) || '…', s.warning ? h('span', { class: 'warning-note' }, `⚠ ${s.warning}`) : null),
    );
  }
  return grid;
}

/** Výběrový seznam odstavců: jeden sloupec originálu s checkboxy. */
function pickView(segments: Segment[]) {
  const job = current!.job;
  const items = pickable(segments);
  const locked = (s: Segment) => s.translation !== undefined;
  const free = items.filter((s) => !locked(s));
  const checks = new Map<number, HTMLInputElement>();
  const pageBoxes: { box: HTMLInputElement; ids: number[] }[] = [];
  const info = h('strong');
  const go = h('button', { class: 'btn primary' }, t('pick.translate'));
  const sync = () => {
    const chosen = free.filter((s) => picked.has(s.id));
    info.textContent = t('pick.count', {
      selected: chosen.length,
      total: free.length,
      chars: chosen.reduce((n, s) => n + s.source.length, 0).toLocaleString(locale()),
    });
    go.disabled = !chosen.length;
    for (const { box, ids } of pageBoxes) {
      const on = ids.filter((id) => picked.has(id)).length;
      box.checked = on === ids.length;
      box.indeterminate = on > 0 && on < ids.length;
    }
  };
  const setAll = (ids: number[], on: boolean) => {
    for (const id of ids) {
      if (on) picked.add(id);
      else picked.delete(id);
      checks.get(id)!.checked = on;
    }
    sync();
  };
  const freeIds = free.map((s) => s.id);
  go.onclick = async () => {
    go.disabled = true;
    try {
      const ids = freeIds.filter((id) => picked.has(id));
      await window.api.translateSegments(job.id, ids);
      toast(t('pick.queued', { count: ids.length }));
      picking = false;
      if (current?.job.id === job.id) void renderBody();
    } catch (e) {
      toast(cleanError(e), true);
      sync();
    }
  };
  const bar = h(
    'div',
    { class: 'pick-bar' },
    info,
    h('button', { class: 'btn', onclick: () => setAll(freeIds, true) }, t('pick.selectAll')),
    h('button', { class: 'btn', onclick: () => setAll(freeIds, false) }, t('pick.clear')),
    job.status === 'done' ? h('button', { class: 'btn', onclick: () => { picking = false; void renderBody(); } }, t('pick.back')) : null,
    go,
  );
  const grid = h('div', { class: 'compare pick' }, h('div', { class: 'compare-head' }, t('detail.originalLang', { lang: languageName(job.sourceLang) })));
  const paged = items.some((s) => s.page && s.page > 1);
  let page: number | undefined;
  for (const s of items) {
    if (paged && s.page && s.page !== page) {
      page = s.page;
      const ids = free.filter((x) => x.page === page).map((x) => x.id);
      const box = h('input', { type: 'checkbox', disabled: !ids.length, checked: !ids.length });
      box.onchange = () => setAll(ids, box.checked);
      if (ids.length) pageBoxes.push({ box, ids });
      grid.append(h('label', { class: 'compare-page pick-page' }, box, `${t('detail.page', { page })} · ${t('pick.wholePage')}`));
    }
    const box = h('input', { type: 'checkbox', disabled: locked(s) });
    box.checked = picked.has(s.id);
    box.onchange = () => {
      if (box.checked) picked.add(s.id);
      else picked.delete(s.id);
      sync();
    };
    checks.set(s.id, box);
    grid.append(h('label', { class: `compare-cell pick-cell${s.kind === 'heading' ? ' heading' : ''}${locked(s) ? ' locked' : ''}` }, box, h('span', {}, s.source)));
  }
  sync();
  return h('div', {}, h('p', { class: 'muted pick-hint' }, t('pick.hint')), bar, grid);
}

/** Výsledek překladu oblasti: řádky tabulky jako tabulka, zbytek jako text se zachovanými řádky. */
function regionResult(text: string) {
  const box = h('div', { class: 'region-result' });
  let block: string[] = [];
  let table = false;
  const flush = () => {
    if (block.length) box.append(table ? tableEl(block.join('\n')) : h('div', { class: 'region-text' }, block.join('\n')));
    block = [];
  };
  for (const line of text.split('\n')) {
    const isRow = line.trim().startsWith('|');
    if (isRow !== table) flush();
    table = isRow;
    block.push(line);
  }
  flush();
  return box;
}

/** Zvětšený výřez stránky vykreslený přímo z PDF (ostrý), šířka max. 720 px. */
async function cropCanvas(pdf: PDFDocumentProxy, number: number, crop: RegionTranslation['crop']) {
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const width = Math.min(720, 2.5 * (crop[2] - crop[0]) * base.width);
  const scale = width / ((crop[2] - crop[0]) * base.width);
  const dpr = window.devicePixelRatio;
  const viewport = page.getViewport({ scale: scale * dpr });
  const canvas = h('canvas');
  canvas.width = Math.max(1, Math.round((crop[2] - crop[0]) * viewport.width));
  canvas.height = Math.max(1, Math.round((crop[3] - crop[1]) * viewport.height));
  canvas.style.width = `${canvas.width / dpr}px`;
  const transform = [1, 0, 0, 1, -crop[0] * viewport.width, -crop[1] * viewport.height];
  await page.render({ canvas, viewport, transform }).promise;
  return canvas;
}

function openRegionDialog(pdf: PDFDocumentProxy, number: number, crop: RegionTranslation['crop']) {
  const id = current!.job.id;
  const result = h('div', { class: 'region-out' });
  const wait = h('span', { class: 'muted' }, t('region.wait'));
  const button = h('button', { class: 'btn primary' }, t('region.translate'));
  const image = h('div', { class: 'region-image' });
  const foot = h('div', { class: 'modal-foot' }, wait, button);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const overlay: HTMLElement = h(
    'div',
    { class: 'modal-overlay', onmousedown: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('strong', {}, `${t('region.title')} · ${t('detail.page', { page: number })}`), h('button', { class: 'btn', title: t('region.close'), 'aria-label': t('region.close'), onclick: close }, icon(ICONS.x))),
      h('div', { class: 'modal-body' }, image, result),
      foot,
    ),
  );
  const show = (text: string) => {
    result.replaceChildren(regionResult(text));
    foot.hidden = true;
  };
  const saved = findRegion(regions, number, crop);
  if (saved) show(saved.text);
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = t('region.translating');
    result.replaceChildren();
    try {
      const region = await window.api.translateRegion(id, number, crop);
      if (current?.job.id === id && !findRegion(regions, region.page, region.crop)) {
        regions.push(region);
        addRegionFrame(pdf, region);
      }
      show(region.text);
    } catch (e) {
      result.replaceChildren(h('div', { class: 'error-box' }, cleanError(e)));
      button.disabled = false;
      button.textContent = t('region.translate');
    }
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  void cropCanvas(pdf, number, crop).then((canvas) => image.replaceChildren(canvas), (e) => image.replaceChildren(h('div', { class: 'error-box' }, cleanError(e))));
}

function placeBox(el: HTMLElement, crop: RegionTranslation['crop']) {
  el.style.left = `${crop[0] * 100}%`;
  el.style.top = `${crop[1] * 100}%`;
  el.style.width = `${(crop[2] - crop[0]) * 100}%`;
  el.style.height = `${(crop[3] - crop[1]) * 100}%`;
}

function addRegionFrame(pdf: PDFDocumentProxy, region: RegionTranslation) {
  for (const layer of regionLayers.get(region.page) ?? []) {
    const frame = h('button', { class: 'region-frame', title: t('region.saved') });
    placeBox(frame, region.crop);
    frame.onmousedown = (e) => e.stopPropagation();
    frame.onclick = () => openRegionDialog(pdf, region.page, region.crop);
    layer.append(frame);
  }
}

const MIN_DRAG = 12;

/** Stránka originálu, na které jde tažením myši označit oblast k přiblížení a překladu. */
function selectablePage(pdf: PDFDocumentProxy, number: number, canvas: HTMLCanvasElement) {
  const wrap = h('div', { class: 'pdf-page' }, canvas);
  wrap.style.width = canvas.style.width;
  regionLayers.set(number, [...(regionLayers.get(number) ?? []), wrap]);
  for (const region of regions) if (region.page === number) addRegionFrame(pdf, region);
  wrap.onmousedown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = wrap.getBoundingClientRect();
    const clampX = (x: number) => Math.min(box.width, Math.max(0, x - box.left));
    const clampY = (y: number) => Math.min(box.height, Math.max(0, y - box.top));
    const [x0, y0] = [clampX(e.clientX), clampY(e.clientY)];
    const draft = h('div', { class: 'region-draft' });
    wrap.append(draft);
    const rect = (ev: MouseEvent) => [Math.min(x0, clampX(ev.clientX)), Math.min(y0, clampY(ev.clientY)), Math.max(x0, clampX(ev.clientX)), Math.max(y0, clampY(ev.clientY))];
    const move = (ev: MouseEvent) => {
      const [a, b, c, d] = rect(ev);
      placeBox(draft, [a / box.width, b / box.height, c / box.width, d / box.height]);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      draft.remove();
      const [a, b, c, d] = rect(ev);
      if (c - a < MIN_DRAG || d - b < MIN_DRAG) return;
      openRegionDialog(pdf, number, normalizeCrop([a / box.width, b / box.height, c / box.width, d / box.height]));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return wrap;
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
  return pdfView(await window.api.readInput(detail.job.id), token, true);
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

const regionHint = () => h('p', { class: 'muted region-hint' }, t('region.hint'));

async function pdfView(data: Uint8Array | null, token: number, selectable = false) {
  const holder = h('div', { class: 'pdf-pages' }, h('p', { class: 'muted' }, t('detail.loadingPdf')));
  if (!data || token !== renderToken) return holder;
  const pdf = await getDocument({ data, ...PDFJS_OPTIONS }).promise;
  holder.replaceChildren();
  if (selectable) holder.append(regionHint());
  const width = Math.min(900, $('detail-body').clientWidth || 800);
  for (let p = 1; p <= pdf.numPages; p++) {
    if (token !== renderToken) break;
    const canvas = await pdfCanvas(pdf, p, width);
    holder.append(selectable ? selectablePage(pdf, p, canvas) : canvas);
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
  holder.append(regionHint());
  for (let p = 1; p <= Math.max(left.numPages, right.numPages); p++) {
    if (token !== renderToken) break;
    const pair = h('div', { class: 'pdf-pair' });
    holder.append(pair);
    const cells = await Promise.all([p <= left.numPages ? pdfCanvas(left, p, width) : null, p <= right.numPages ? pdfCanvas(right, p, width) : null]);
    pair.append(cells[0] ? selectablePage(left, p, cells[0]) : h('div'), cells[1] ?? h('div'));
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
  if (job.cost) {
    const actual = formatUsd(job.cost);
    row(t('detail.info.cost'), job.costEstimate ? t('detail.info.costWithEstimate', { amount: actual, estimate: formatUsd(job.costEstimate) }) : actual);
  } else if (isOnline(job) && job.costEstimate) row(t('detail.info.costEstimate'), `≈ ${formatUsd(job.costEstimate)}`);
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
    regionLayers = new Map();
    regions = job.ext.toLowerCase() === '.pdf' && tab !== 'translated-pdf' ? await window.api.jobRegions(job.id).catch(() => []) : [];
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
  if (tab === 'compare' && isPicking()) {
    if (job.status === 'picking' && !picking) startPicking();
    return body.replaceChildren(pickView(segments));
  }
  body.replaceChildren(tab === 'compare' ? compareView(visible(segments)) : documentView(visible(segments).filter((s) => !s.skipped), finalText));
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
  picking = false;
  renderHeader();
  await renderBody();
  return true;
}

/** Živá aktualizace: hlavička hned, obsah až po dokončení (segmenty se ukládají na konci). */
export async function updateDetail(job: Job) {
  if (!current || current.job.id !== job.id) return;
  const changed = current.job.status !== job.status;
  const finished = changed && !['running', 'queued'].includes(job.status);
  current.job = job;
  if (changed && (job.status === 'queued' || job.status === 'running')) {
    picking = false;
    renderHeader();
    return renderBody();
  }
  renderHeader();
  if (finished) {
    picking = false;
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
