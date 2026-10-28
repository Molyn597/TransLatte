import { getLang, resolveLang, setLang, t, type MessageKey } from '../shared/i18n';
import { languageName, LANGUAGES } from '../shared/languages';
import { CHARS_PER_PAGE } from '../shared/cost';
import { estimateFiles, formatUsd, setCurrency, setCzkRate } from '../shared/estimate';
import { isValidPageRange } from '../shared/pages';
import { activeModels, activeRates, isOnline } from '../shared/provider';
import type { Api, FileInfo, Job, LmStatus, Mode, Models, Provider, Settings } from '../shared/types';
import { closeDetail, detailJobId, openDetail, setupDetail, updateDetail } from './detail';
import {
  applyI18n,
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
  statusIcon,
  STATUS_TEXT,
  toast,
} from './dom';
import { renderGlossary, renderSettings, setupGlossary } from './forms';

declare global {
  interface Window {
    api: Api;
  }
}

type View = 'home' | 'history' | 'detail' | 'glossary' | 'settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ROLE_NAMES: Record<keyof Models, MessageKey> = { ocr: 'role.ocr', translate: 'role.translate', polish: 'role.polish' };
// Stránka článku má 8 odstavců; opravu potřebuje zhruba 15 % z nich.
const FIXES_PER_PAGE = 8 * 0.15;
const CONTEXT_SECONDS = 10;

let settings: Settings;
let jobs = new Map<string, Job>();
let view: View = 'home';
let previousView: View = 'home';
// Vybrané soubory čekají na tlačítko Přeložit; info se dotáhne kvůli počtu stran a odhadu ceny.
let pending: { path: string; name: string; info?: FileInfo | null }[] = [];
const TYPICAL_PAGES = 15;
let lastStatus: LmStatus | undefined;
let catalog: LmStatus['models'] = [];

// ---------- Navigace ----------

function show(next: View) {
  if (view !== 'detail') previousView = view;
  view = next;
  for (const el of document.querySelectorAll<HTMLElement>('.view')) el.hidden = el.dataset.view !== next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    b.classList.toggle('active', b.dataset.nav === next || (next === 'detail' && b.dataset.nav === 'history'));
  }
  if (next !== 'detail') closeDetail();
  if (next === 'glossary') void renderGlossary();
  if (next === 'settings') void renderSettings(onSettingsSaved);
  if (next === 'history') renderHistory();
  $('detail-body').closest('.main')?.scrollTo(0, 0);
}

async function openJob(id: string) {
  if (await openDetail(id)) show('detail');
}

// ---------- LM Studio ----------

async function refreshStatus() {
  const lm = await window.api.lmStatus();
  // Odpověď z doby před přepnutím poskytovatele.
  if ((lm.provider ?? 'local') !== settings.provider) return;
  lastStatus = lm;
  const dot = $('status-dot');
  dot.className = `status-dot ${lm.online ? 'online' : 'offline'}`;
  const remote = lm.provider === 'openrouter';
  $('lm-title').textContent = remote ? t('lm.titleOnline') : 'LM Studio';
  dot.title = $('lm-title').textContent;
  $('lm-state').textContent = remote
    ? lm.online
      ? t('lm.remoteOk')
      : lm.hasKey
        ? t('lm.remoteFail')
        : t('lm.noKey')
    : lm.online
      ? t('lm.running')
      : lm.cli
        ? t('lm.stopped')
        : t('lm.notFound');
  catalog = lm.models;
  renderCost();
  renderEngine();
  const models = activeModels(settings);
  $('lm-models').replaceChildren(
    ...(Object.keys(ROLE_NAMES) as (keyof Models)[]).map((role) => {
      const missing = lm.missing.includes(role);
      const name = lm.models.find((m) => m.key === models[role])?.name ?? models[role];
      return h(
        'li',
        {},
        h('span', { class: 'role' }, t(ROLE_NAMES[role])),
        h('span', { class: missing ? 'model missing' : 'model', title: name }, missing ? t('lm.missing', { name }) : name),
      );
    }),
  );
}

const modelName = (id: string) => catalog.find((m) => m.key === id)?.name ?? id.split('/').pop()!;

/** Výrazně ukáže, čím se bude překládat, a u online i stav API klíče. */
function renderEngine() {
  const online = isOnline(settings);
  $('provider-switch').replaceChildren(
    ...(['local', 'openrouter'] as Provider[]).map((p) =>
      h(
        'button',
        {
          class: settings.provider === p ? 'provider active' : 'provider',
          role: 'radio',
          'aria-checked': String(settings.provider === p),
          onclick: async () => {
            if (settings.provider === p) return;
            settings.provider = p;
            await window.api.saveSettings(settings);
            lastStatus = undefined;
            renderAll();
            void refreshStatus();
          },
        },
        h('span', { class: 'provider-title' }, t(`home.provider.${p}`)),
        h('span', { class: 'provider-desc' }, t(`home.provider.${p}Desc`)),
      ),
    ),
  );
  const names = [...new Set(Object.values(activeModels(settings)))].map(modelName);
  const status = !lastStatus
    ? h('span', { class: 'chip' }, t('lm.checking'))
    : online
      ? lastStatus.hasKey
        ? h('span', { class: 'chip ok' }, icon(ICONS.check), t('home.keySaved'))
        : h('span', { class: 'chip warn' }, icon(ICONS.alert), t('home.keyMissing'))
      : h('span', { class: lastStatus.online || lastStatus.cli ? 'chip ok' : 'chip warn' }, lastStatus.online ? t('lm.running') : lastStatus.cli ? t('home.lmReady') : t('lm.notFound'));
  $('engine').replaceChildren(
    h('div', { class: 'engine-label' }, t(online ? 'home.engineOnline' : 'home.engineLocal')),
    h('div', { class: 'engine-models' }, names.join(' + ')),
    h('div', { class: 'chips' }, status, h('button', { class: 'link', onclick: () => show('settings') }, t('home.changeModel'))),
  );
  renderStart();
}

function renderStart() {
  const noKey = isOnline(settings) && lastStatus?.hasKey === false;
  const button = $<HTMLButtonElement>('start');
  button.disabled = !pending.length || noKey;
  button.textContent = pending.length > 1 ? t('home.startMany', { count: pending.length }) : t('home.start');
  $('start-hint').textContent = noKey ? t('home.keyMissingHint') : pending.length ? '' : t('home.startHint');
}

function renderAll() {
  renderModes();
  renderEngine();
  renderCost();
}

// ---------- Domů ----------

function modeTime(mode: Mode) {
  const r = activeRates(settings);
  const k = CHARS_PER_PAGE / 1000;
  const seconds =
    k * r.translatePerKChar +
    (mode === 'fast' ? 0 : r.ocrPerPage + FIXES_PER_PAGE * r.fixPerSegment) +
    (mode === 'quality' ? CONTEXT_SECONDS : 0);
  return t('home.timePerPage', { time: duration(seconds) });
}

function renderModes() {
  $('modes').replaceChildren(
    ...(Object.keys(MODES) as Mode[]).map((mode) =>
      h(
        'button',
        {
          class: settings.mode === mode ? 'mode active' : 'mode',
          role: 'radio',
          'aria-checked': String(settings.mode === mode),
          onclick: async () => {
            settings.mode = mode;
            renderModes();
            renderCost();
            await window.api.saveSettings(settings);
          },
        },
        h('span', { class: 'mode-title' }, icon(ICONS[mode]), t(MODES[mode].title)),
        h('span', { class: 'mode-desc' }, t(MODES[mode].desc)),
        h('span', { class: 'mode-time' }, modeTime(mode)),
      ),
    ),
  );
}

/** Odhad ceny: vždy pro typický článek v aktuálním režimu, po přidání souborů i pro ně (s režimem a rozsahem, se kterými se zařadily). */
function renderCost() {
  // Podtitulek slibuje lokální zpracování; online by to nebyla pravda.
  $('home-subtitle').textContent = t(isOnline(settings) ? 'home.subtitleOnline' : 'home.subtitle');
  const el = $('cost-estimate');
  const models = settings.remoteModels;
  const prices = Object.fromEntries(catalog.map((m) => [m.key, m.price]));
  if (!isOnline(settings) || !Object.values(models).every((m) => prices[m])) {
    el.hidden = true;
    return;
  }
  const names = [...new Set(Object.values(models))].map((id) => catalog.find((m) => m.key === id)?.name ?? id).join(', ');
  const factors = settings.remoteCostFactors;
  const typical = estimateFiles({ files: [{ kind: 'pdf', pages: TYPICAL_PAGES }], mode: settings.mode, models, prices, factors });
  const lines = [
    h(
      'div',
      {},
      typical.free ? t('home.costTypicalFree', { model: names }) : t('home.costTypical', { amount: formatUsd(typical.usd ?? 0), pages: TYPICAL_PAGES, model: names }),
    ),
  ];
  const files = pending.map((p) => p.info).filter((i): i is FileInfo => Boolean(i));
  if (files.length) {
    const pageRange = $<HTMLInputElement>('page-range').value;
    const est = estimateFiles({ files, pageRange: isValidPageRange(pageRange) ? pageRange : '', mode: settings.mode, models, prices, factors });
    const pages = t('cost.pages', { count: est.pages });
    const known = est.free || est.usd !== undefined;
    const line = !known ? t('home.costDocxOnly') : est.free || est.usd === 0 ? t('home.costFree', { pages }) : t('home.cost', { amount: formatUsd(est.usd!), pages });
    lines.push(h('div', {}, line, est.unknownDocx && known ? ` · ${t('home.costDocx')}` : '', h('span', { class: 'muted' }, ` ${t('home.costActual')}`)));
  }
  el.replaceChildren(...lines);
  el.hidden = false;
}

function fillLanguages() {
  const source = $<HTMLSelectElement>('source-lang');
  const target = $<HTMLSelectElement>('target-lang');
  source.replaceChildren(h('option', { value: 'auto' }, t('lang.auto')));
  for (const l of LANGUAGES) {
    source.append(h('option', { value: l.code }, languageName(l.code)));
    target.append(h('option', { value: l.code }, languageName(l.code)));
  }
  source.value = settings.sourceLang;
  target.value = settings.targetLang;
  const keep = $<HTMLInputElement>('keep-figures');
  keep.checked = settings.keepFigures;
  keep.addEventListener('change', async () => {
    settings.keepFigures = keep.checked;
    await window.api.saveSettings(settings);
  });
  const save = async () => {
    settings.sourceLang = source.value;
    settings.targetLang = target.value;
    await window.api.saveSettings(settings);
  };
  source.addEventListener('change', save);
  target.addEventListener('change', save);
}

async function addFiles(paths: string[]) {
  const fresh = [...new Set(paths)].filter((p) => !pending.some((x) => x.path === p));
  if (!fresh.length) return;
  const added: typeof pending = fresh.map((path) => ({ path, name: path.split(/[\\/]/).pop()! }));
  pending.push(...added);
  renderPending();
  const infos = await window.api.fileInfo(fresh).catch(() => []);
  added.forEach((p, i) => (p.info = infos[i] ?? null));
  renderPending();
}

function fileMeta(info: FileInfo | null | undefined) {
  if (info === undefined) return '…';
  if (!info) return t('home.fileUnreadable');
  if (info.kind === 'pdf') return t('cost.pages', { count: info.pages });
  if (info.kind === 'text') return t('home.fileChars', { chars: info.chars.toLocaleString(getLang()) });
  return 'Word';
}

function renderPending() {
  $('pending').hidden = !pending.length;
  $('pending-list').replaceChildren(
    ...pending.map((p) =>
      h(
        'div',
        { class: 'pending-row' },
        icon(ICONS.file),
        h('span', { class: 'pending-name', title: p.path }, p.name),
        h('span', { class: 'muted small' }, fileMeta(p.info)),
        h(
          'button',
          {
            class: 'circle-btn small',
            title: t('home.pendingRemove'),
            onclick: () => {
              pending = pending.filter((x) => x !== p);
              renderPending();
            },
          },
          icon(ICONS.x),
        ),
      ),
    ),
  );
  renderCost();
  renderStart();
}

async function startPending() {
  if (!pending.length) return;
  const pageRange = $<HTMLInputElement>('page-range').value;
  if (!isValidPageRange(pageRange)) {
    toast(t('home.badRange'), true);
    return;
  }
  const paths = pending.map((p) => p.path);
  try {
    await window.api.addJobs(paths, {
      mode: settings.mode,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      pageRange,
      pickParagraphs: $<HTMLInputElement>('pick-paragraphs').checked,
      keepFigures: $<HTMLInputElement>('keep-figures').checked,
      provider: settings.provider,
    });
    pending = [];
    renderPending();
    toast(paths.length === 1 ? t('home.queued') : t('home.queuedMany', { count: paths.length }));
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
}

function setupDrop() {
  const zone = $('dropzone');
  zone.addEventListener('click', async () => addFiles(await window.api.pickFiles()));
  let depth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    zone.classList.add('over');
    if (view !== 'home') show('home');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) zone.classList.remove('over');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    void addFiles(files.map((f) => window.api.pathForFile(f)).filter(Boolean));
  });
}

function jobCard(job: Job) {
  const info = progressInfo(job);
  return h(
    'div',
    { class: 'job-card' },
    h(
      'div',
      {},
      h('div', { class: 'job-card-name' }, `${job.name}${job.ext}`),
      h('div', { class: 'job-card-stage' }, [info.label, info.eta, t(MODES[job.mode].title)].filter(Boolean).join(' · ')),
    ),
    h(
      'div',
      { class: 'row gap' },
      h('button', { class: 'btn', onclick: () => openJob(job.id) }, t('job.open')),
      h('button', { class: 'btn danger', onclick: () => window.api.cancelJob(job.id) }, icon(ICONS.stop), t('job.cancel')),
    ),
    progressBar(info.fraction),
  );
}

function jobRow(job: Job) {
  const parts = [t(STATUS_TEXT[job.status]), date(job.createdAt), t(MODES[job.mode].title), langPair(job), jobDuration(job)];
  if (job.status === 'running' || job.status === 'queued') {
    const info = progressInfo(job);
    parts.splice(1, 0, info.label);
  }
  return h(
    'button',
    { class: 'job-row', onclick: () => openJob(job.id) },
    statusIcon(job),
    h(
      'span',
      {},
      h('div', { class: 'job-row-name' }, `${job.name}${job.ext}`),
      h('div', { class: 'job-row-meta' }, parts.filter(Boolean).join(' · ')),
    ),
    isOnline(job) ? h('span', { class: 'chip' }, job.models ? `${t('job.online')} · ${modelName(job.models.translate)}` : t('job.online')) : '',
    job.warnings ? h('span', { class: 'chip warn' }, t('job.warnings', { count: job.warnings })) : job.status === 'error' ? h('span', { class: 'chip err' }, t('status.error')) : '',
  );
}

const sorted = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';

function renderHome() {
  const active = sorted()
    .filter(isActive)
    .sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : a.createdAt - b.createdAt));
  $('active-title').hidden = !active.length;
  $('active-jobs').replaceChildren(...active.map(jobCard));
  const recent = sorted()
    .filter((j) => !isActive(j))
    .slice(0, 4);
  $('recent-title').hidden = !recent.length;
  $('recent-jobs').replaceChildren(...recent.map(jobRow));
  const badge = $('active-badge');
  badge.hidden = !active.length;
  badge.textContent = String(active.length);
}

function renderHistory() {
  const query = $<HTMLInputElement>('history-search').value.trim().toLowerCase();
  const list = sorted().filter((j) => !query || j.name.toLowerCase().includes(query));
  $('history-list').replaceChildren(...list.map(jobRow));
  $('history-empty').hidden = list.length > 0;
}

const applyTheme = () => (document.documentElement.dataset.theme = settings.theme);

function onSettingsSaved(next: Settings) {
  settings = next;
  setCurrency(settings.currency);
  applyTheme();
  renderAll();
  void refreshStatus();
}

// ---------- Start ----------

async function init() {
  document.body.classList.add(`platform-${window.api.platform}`);
  settings = await window.api.getSettings();
  setCzkRate(settings.usdCzk?.rate);
  setCurrency(settings.currency);
  setLang(resolveLang(settings.uiLang, navigator.language));
  document.documentElement.lang = getLang();
  applyI18n();
  applyTheme();
  jobs = new Map((await window.api.listJobs()).map((j) => [j.id, j]));

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    b.addEventListener('click', () => show(b.dataset.nav as View));
  }
  setupDetail(() => show(previousView));
  setupGlossary();
  setupDrop();
  fillLanguages();
  renderAll();
  renderHome();
  $('history-search').addEventListener('input', renderHistory);
  const pageRange = $<HTMLInputElement>('page-range');
  pageRange.addEventListener('input', () => {
    pageRange.classList.toggle('invalid', !isValidPageRange(pageRange.value));
    renderCost();
  });
  $('start').addEventListener('click', () => void startPending());
  $('pending-clear').addEventListener('click', () => {
    pending = [];
    renderPending();
  });
  // Dnešní kurz ČNB se dotáhne na pozadí; do té doby platí poslední uložený.
  void window.api.usdCzk().catch(() => undefined).then((rate) => {
    setCzkRate(rate);
    renderCost();
  });
  $('lm-refresh').addEventListener('click', () => void refreshStatus());

  window.api.onJobUpdate((job) => {
    const wasActive = jobs.get(job.id) && isActive(jobs.get(job.id)!);
    jobs.set(job.id, job);
    renderHome();
    if (view === 'history') renderHistory();
    if (detailJobId() === job.id) void updateDetail(job);
    // Po doběhnutí se zpřesní odhad času v kartách režimů.
    if (wasActive && !isActive(job)) {
      void window.api.getSettings().then((s) => {
        settings = s;
        renderModes();
      });
    }
  });
  window.api.onJobRemoved((id) => {
    jobs.delete(id);
    renderHome();
    if (view === 'history') renderHistory();
    if (detailJobId() === id) show(previousView === 'detail' ? 'history' : previousView);
  });
  window.api.onOpenJob((id) => void openJob(id));

  await refreshStatus();
  setInterval(() => void refreshStatus(), 20000);
  window.addEventListener('focus', () => void refreshStatus());
}

void init();
