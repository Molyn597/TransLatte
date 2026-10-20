import { LANGUAGES } from '../shared/languages';
import type { Api, Job, Mode, Models, Settings } from '../shared/types';
import { closeDetail, detailJobId, openDetail, setupDetail, updateDetail } from './detail';
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
const ROLE_NAMES: Record<keyof Models, string> = { ocr: 'OCR', translate: 'Překlad', polish: 'Uhlazení' };
// Průměrná stránka článku má kolem 3000 znaků.
const CHARS_PER_PAGE = 3000;

let settings: Settings;
let jobs = new Map<string, Job>();
let view: View = 'home';
let previousView: View = 'home';

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
  const dot = $('status-dot');
  dot.className = `status-dot ${lm.online ? 'online' : 'offline'}`;
  $('lm-state').textContent = lm.online
    ? 'Server běží'
    : lm.cli
      ? 'Server neběží – spustí se sám při překladu'
      : 'LM Studio nenalezeno';
  $('lm-models').replaceChildren(
    ...(Object.keys(ROLE_NAMES) as (keyof Models)[]).map((role) => {
      const missing = lm.missing.includes(role);
      const name = lm.models.find((m) => m.key === settings.models[role])?.name ?? settings.models[role];
      return h(
        'li',
        {},
        h('span', { class: 'role' }, ROLE_NAMES[role]),
        h('span', { class: missing ? 'model missing' : 'model', title: name }, missing ? `chybí: ${name}` : name),
      );
    }),
  );
}

// ---------- Domů ----------

function modeTime(mode: Mode) {
  const r = settings.rates;
  const k = CHARS_PER_PAGE / 1000;
  const seconds =
    k * r.translatePerKChar + (mode === 'fast' ? 0 : r.ocrPerPage) + (mode === 'quality' ? k * r.polishPerKChar : 0);
  return `≈ ${duration(seconds)} na stránku`;
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
            await window.api.saveSettings(settings);
          },
        },
        h('span', { class: 'mode-title' }, icon(ICONS[mode]), MODES[mode].title),
        h('span', { class: 'mode-desc' }, MODES[mode].desc),
        h('span', { class: 'mode-time' }, modeTime(mode)),
      ),
    ),
  );
}

function fillLanguages() {
  const source = $<HTMLSelectElement>('source-lang');
  const target = $<HTMLSelectElement>('target-lang');
  source.replaceChildren(h('option', { value: 'auto' }, 'Rozpoznat automaticky'));
  for (const l of LANGUAGES) {
    source.append(h('option', { value: l.code }, l.name));
    target.append(h('option', { value: l.code }, l.name));
  }
  source.value = settings.sourceLang;
  target.value = settings.targetLang;
  const save = async () => {
    settings.sourceLang = source.value;
    settings.targetLang = target.value;
    await window.api.saveSettings(settings);
  };
  source.addEventListener('change', save);
  target.addEventListener('change', save);
}

async function addFiles(paths: string[]) {
  if (!paths.length) return;
  try {
    await window.api.addJobs(paths, { mode: settings.mode, sourceLang: settings.sourceLang, targetLang: settings.targetLang });
    toast(paths.length === 1 ? 'Přidáno do fronty' : `Přidáno do fronty: ${paths.length} souborů`);
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
      h('div', { class: 'job-card-stage' }, [info.label, info.eta, MODES[job.mode].title].filter(Boolean).join(' · ')),
    ),
    h(
      'div',
      { class: 'row gap' },
      h('button', { class: 'btn', onclick: () => openJob(job.id) }, 'Detail'),
      h('button', { class: 'btn danger', onclick: () => window.api.cancelJob(job.id) }, icon(ICONS.stop), 'Zrušit'),
    ),
    progressBar(info.fraction),
  );
}

function jobRow(job: Job) {
  const parts = [STATUS_TEXT[job.status], date(job.createdAt), MODES[job.mode].title, langPair(job), jobDuration(job)];
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
    job.warnings ? h('span', { class: 'chip warn' }, `${job.warnings}× upozornění`) : job.status === 'error' ? h('span', { class: 'chip err' }, 'Chyba') : '',
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
  applyTheme();
  renderModes();
  void refreshStatus();
}

// ---------- Start ----------

async function init() {
  document.body.classList.add(`platform-${window.api.platform}`);
  settings = await window.api.getSettings();
  applyTheme();
  jobs = new Map((await window.api.listJobs()).map((j) => [j.id, j]));

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    b.addEventListener('click', () => show(b.dataset.nav as View));
  }
  setupDetail(() => show(previousView));
  setupGlossary();
  setupDrop();
  fillLanguages();
  renderModes();
  renderHome();
  $('history-search').addEventListener('input', renderHistory);
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
