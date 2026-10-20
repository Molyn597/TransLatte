import { languageName } from '../shared/languages';
import type { Job, Mode, Stage } from '../shared/types';

type Child = Node | string | null | undefined | false;

/** Vytvoří element; text jde vždy přes textContent, výstup modelů se nikdy nevkládá jako HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, ''), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false) el.setAttribute(key, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

/** Statické ikony z tohoto souboru (nikdy ne obsah z dokumentu). */
export function icon(path: string) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  return span.firstElementChild as SVGElement;
}

export const ICONS = {
  fast: '<path d="M13 2L4 14h7l-1 8 9-12h-7z" />',
  balanced: '<path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />',
  quality: '<path d="M6 3h12l3 6-9 12L3 9z" /><path d="M3 9h18M9 3l3 18 3-18" />',
  check: '<path d="M5 12l5 5L20 7" />',
  x: '<path d="M6 6l12 12M18 6L6 18" />',
  clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />',
  alert: '<path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" />',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" />',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  download: '<path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" />',
  retry: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" />',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6" />',
};

export const MODES: Record<Mode, { title: string; desc: string }> = {
  fast: { title: 'Rychlý', desc: 'Text z PDF, OCR jen u skenů. Chyby jen označí.' },
  balanced: { title: 'Vyvážený', desc: 'OCR všech stránek, kontrola a oprava chyb.' },
  quality: { title: 'Kvalitní', desc: 'Navíc kontext dokumentu (téma, autor) pro přesnější opravy.' },
};

export const STAGES: Record<Stage, string> = {
  prepare: 'Připravuji LM Studio',
  extract: 'Čtu dokument',
  ocr: 'Čtu stránky (OCR)',
  tables: 'Čtu tabulky',
  context: 'Čtu kontext dokumentu',
  translate: 'Překládám',
  check: 'Kontroluji překlad',
  fix: 'Opravuji chyby',
  write: 'Ukládám výsledek',
};

export function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function date(ms: number) {
  return new Date(ms).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function jobDuration(job: Job) {
  return job.startedAt && job.finishedAt ? duration((job.finishedAt - job.startedAt) / 1000) : '';
}

export function langPair(job: Job) {
  const src = job.sourceLang === 'auto' ? 'auto' : languageName(job.sourceLang);
  return `${src} → ${languageName(job.targetLang)}`;
}

export const STATUS_TEXT: Record<Job['status'], string> = {
  queued: 'Čeká ve frontě',
  running: 'Překládá se',
  done: 'Hotovo',
  error: 'Chyba',
  cancelled: 'Zrušeno',
};

export function statusIcon(job: Job) {
  const map = { done: ICONS.check, error: ICONS.alert, running: ICONS.clock, queued: ICONS.clock, cancelled: ICONS.x };
  return h('span', { class: `status-icon status-${job.status}`, title: STATUS_TEXT[job.status] }, icon(map[job.status]));
}

/** Průběh úlohy jako text a podíl 0–1 (null = neurčitý). */
export function progressInfo(job: Job): { label: string; fraction: number | null; eta: string } {
  if (job.status === 'queued') return { label: 'Čeká ve frontě', fraction: 0, eta: '' };
  const p = job.progress;
  if (!p) return { label: 'Spouštím…', fraction: null, eta: '' };
  const counter =
    p.total && p.stage === 'ocr'
      ? ` · stránka ${Math.min(p.done + 1, p.total)} z ${p.total}`
      : p.total
        ? ` · ${Math.round((p.done / p.total) * 100)} %`
        : '';
  return {
    label: STAGES[p.stage] + counter,
    fraction: p.total ? p.done / p.total : null,
    eta: p.eta !== undefined ? `zbývá asi ${duration(p.eta)}` : '',
  };
}

export function progressBar(fraction: number | null) {
  const bar = h('div', { class: fraction === null ? 'bar indeterminate' : 'bar' }, h('span'));
  (bar.firstElementChild as HTMLElement).style.width = `${Math.round((fraction ?? 0) * 100)}%`;
  return bar;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, error = false) {
  const el = document.getElementById('toast')!;
  el.textContent = text;
  el.className = error ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 7000 : 3500);
}
