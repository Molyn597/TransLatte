import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { t } from '../shared/i18n';
import { h, icon, ICONS } from './dom';

// Zoom násobí základní šířku stránky („přizpůsobit šířce“ = 1).
const MIN = 0.5;
const MAX = 3;
const STORE = 'pdfZoom';
const KEY_STEP = 1.25;
const SETTLE_MS = 250;
// Strop počtu pixelů jednoho plátna (při velkém zoomu by jinak vzniklo plátno na stovky MB).
const MAX_PIXELS = 24e6;

interface Slot {
  pdf: PDFDocumentProxy;
  number: number;
  canvas: HTMLCanvasElement;
  pw: number;
  ph: number;
  // Cílová CSS šířka, šířka poslední vykreslené bitmapy a šířka rozdělaného vykreslování.
  width: number;
  drawn: number;
  drawing: number;
  // Zahodí výsledek zastaralého vykreslování.
  gen: number;
  task: RenderTask | null;
  // Stránka je ve viditelné oblasti nebo těsně vedle ní.
  near: boolean;
}

interface Pages {
  holder: HTMLElement;
  base: () => number;
  slots: Slot[];
  spacers: HTMLElement[];
  observer: IntersectionObserver;
}

const slotOf = new WeakMap<Element, Slot>();
let zoom = loadZoom();
let pages: Pages | null = null;
let scroller: HTMLElement;
let dock: HTMLElement;
let slider: HTMLInputElement;
let label: HTMLElement;
let fitButton: HTMLButtonElement;
let settleTimer = 0;
let resizeTimer = 0;

function loadZoom() {
  try {
    const v = Number(localStorage.getItem(STORE));
    return v >= MIN && v <= MAX ? v : 1;
  } catch {
    return 1;
  }
}

function saveZoom() {
  try {
    localStorage.setItem(STORE, String(zoom));
  } catch {
    // úložiště nemusí být dostupné
  }
}

function syncUi() {
  slider.value = String(Math.round(zoom * 100));
  label.textContent = `${Math.round(zoom * 100)} %`;
  fitButton.classList.toggle('on', Math.abs(zoom - 1) < 0.001);
}

/** Nastaví šířky všech stránek (okamžitě, jen CSS; ostrost dohoní draw). */
function layout(p: Pages) {
  const width = Math.round(p.base() * zoom);
  for (const s of p.slots) {
    s.width = width;
    s.canvas.style.width = `${width}px`;
    s.canvas.style.height = `${(width * s.ph) / s.pw}px`;
    if (s.canvas.parentElement && s.canvas.parentElement !== p.holder) s.canvas.parentElement.style.width = `${width}px`;
    if (s.task && s.drawing !== width) {
      s.task.cancel();
      s.gen++;
      s.drawing = 0;
    }
  }
  for (const el of p.spacers) el.style.width = `${width}px`;
}

async function draw(s: Slot) {
  const width = s.width;
  if (s.drawn === width || s.drawing === width) return;
  s.task?.cancel();
  const gen = ++s.gen;
  s.drawing = width;
  try {
    const page = await s.pdf.getPage(s.number);
    if (gen !== s.gen) return;
    const scale = Math.min((width / s.pw) * window.devicePixelRatio, Math.sqrt(MAX_PIXELS / (s.pw * s.ph)));
    const viewport = page.getViewport({ scale });
    // Vykreslí se bokem a do viditelného plátna se vloží najednou, ať při překreslení neblikne.
    const tmp = document.createElement('canvas');
    tmp.width = Math.ceil(viewport.width);
    tmp.height = Math.ceil(viewport.height);
    s.task = page.render({ canvas: tmp, viewport });
    await s.task.promise;
    if (gen !== s.gen) return;
    s.canvas.width = tmp.width;
    s.canvas.height = tmp.height;
    s.canvas.getContext('2d')!.drawImage(tmp, 0, 0);
    s.drawn = width;
  } catch (e) {
    // Zrušené vykreslování (změna zoomu) je v pořádku.
    if (gen === s.gen && (e as Error).name !== 'RenderingCancelledException') console.error(e);
  } finally {
    if (gen === s.gen) {
      s.drawing = 0;
      s.task = null;
    }
  }
}

/** Uvolní bitmapu stránky mimo viditelnou oblast (rozměr zůstává dán CSS). */
function release(s: Slot) {
  s.task?.cancel();
  s.task = null;
  s.gen++;
  s.drawing = 0;
  if (s.drawn) {
    s.canvas.width = 0;
    s.canvas.height = 0;
    s.drawn = 0;
  }
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const e of entries) {
    const s = slotOf.get(e.target);
    if (!s) continue;
    s.near = e.isIntersecting;
    // Během gesta se nekreslí; vše dožene settle.
    if (!s.near) release(s);
    else if (!settleTimer) void draw(s);
  }
}

function scheduleSettle() {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    for (const s of pages?.slots ?? []) if (s.near) void draw(s);
  }, SETTLE_MS);
}

/** Stránka nejblíž bodu a poloha bodu v ní (zlomky), aby šel po změně velikosti vrátit pod kurzor. */
function anchorRef(p: Pages, x: number, y: number) {
  let best: { el: HTMLElement; u: number; v: number; dist: number } | null = null;
  for (const { canvas } of p.slots) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dist = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (!best || dist < best.dist) best = { el: canvas, u: (x - r.left) / r.width, v: (y - r.top) / r.height, dist };
  }
  return best;
}

function viewCenter() {
  const r = scroller.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function setZoom(next: number, at: { x: number; y: number } = viewCenter()) {
  next = Math.round(Math.min(MAX, Math.max(MIN, next)) * 1000) / 1000;
  const p = pages;
  if (!p || next === zoom) return;
  const ref = anchorRef(p, at.x, at.y);
  zoom = next;
  saveZoom();
  syncUi();
  layout(p);
  if (ref) {
    const r = ref.el.getBoundingClientRect();
    p.holder.scrollLeft += r.left + ref.u * r.width - at.x;
    scroller.scrollTop += r.top + ref.v * r.height - at.y;
  }
  scheduleSettle();
}

export function releasePages() {
  const p = pages;
  if (!p) return;
  pages = null;
  dock.hidden = true;
  window.clearTimeout(settleTimer);
  settleTimer = 0;
  p.observer.disconnect();
  for (const s of p.slots) {
    s.task?.cancel();
    s.gen++;
  }
}

/**
 * Stránky PDF s líným vykreslováním a zoomem. `base` vrací šířku stránky při zoomu 100 %
 * (smí si upravit i okolní rozvržení); `holder` je kontejner stránek s vodorovným posunem.
 */
export function createPages(holder: HTMLElement, base: () => number) {
  releasePages();
  const p: Pages = { holder, base, slots: [], spacers: [], observer: new IntersectionObserver(onIntersect, { root: scroller, rootMargin: '100% 0px' }) };
  pages = p;
  dock.hidden = false;
  syncUi();
  return {
    /** Prázdné plátno se správným rozměrem; obsah se vykreslí, až bude stránka na řadě. */
    async canvas(pdf: PDFDocumentProxy, number: number) {
      const { width: pw, height: ph } = (await pdf.getPage(number)).getViewport({ scale: 1 });
      const canvas = h('canvas');
      // Rozměr stránky v bodech: souřadnice segmentů se přepočítají na procenta.
      canvas.dataset.pw = String(pw);
      canvas.dataset.ph = String(ph);
      if (pages === p) {
        const slot: Slot = { pdf, number, canvas, pw, ph, width: 0, drawn: 0, drawing: 0, gen: 0, task: null, near: false };
        p.slots.push(slot);
        slotOf.set(canvas, slot);
        p.observer.observe(canvas);
        slot.width = Math.round(p.base() * zoom);
        canvas.style.width = `${slot.width}px`;
        canvas.style.height = `${(slot.width * ph) / pw}px`;
      }
      return canvas;
    },
    /** Prázdné místo vedle stránky, která v druhém dokumentu chybí. */
    spacer() {
      const el = h('div', { class: 'pdf-spacer' });
      el.style.width = `${Math.round(base() * zoom)}px`;
      p.spacers.push(el);
      return el;
    },
    destroy() {
      if (pages === p) releasePages();
    },
  };
}

export function setupPdfZoom() {
  // Detail má vlastní posuvnou čtecí oblast; hlavička a lišty nad ní zůstávají na místě.
  scroller = document.getElementById('detail-scroll')!;
  const body = document.getElementById('detail-body')!;
  const button = (key: 'zoom.in' | 'zoom.out' | 'zoom.fit', path: string, onclick: () => void) =>
    h('button', { class: 'zoom-btn', type: 'button', title: t(key), 'aria-label': t(key), onclick }, icon(path));
  slider = h('input', { class: 'zoom-slider', type: 'range', min: String(MIN * 100), max: String(MAX * 100), step: '1', 'aria-label': t('zoom.level') });
  slider.oninput = () => setZoom(+slider.value / 100);
  label = h('span', { class: 'zoom-value' });
  fitButton = button('zoom.fit', ICONS.fit, () => setZoom(1));
  dock = h(
    'div',
    { class: 'zoom-dock', hidden: true },
    h('div', { class: 'zoom-pill' }, button('zoom.out', ICONS.minus, () => setZoom(zoom / KEY_STEP)), slider, label, button('zoom.in', ICONS.plus, () => setZoom(zoom * KEY_STEP)), fitButton),
  );
  body.after(dock);
  syncUi();

  // Pinch na trackpadu přichází jako wheel s ctrlKey; plynulé měřítko podle deltaY.
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!pages || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // Kolečko myši dává velké skoky, pinch malé; skok se omezí.
      const delta = Math.max(-25, Math.min(25, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
      setZoom(zoom * Math.exp(-delta * 0.01), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );

  document.addEventListener('keydown', (e) => {
    if (!pages || !(e.metaKey || e.ctrlKey) || e.altKey || !body.offsetParent) return;
    if ((e.target as HTMLElement).closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
    if (e.key === '=' || e.key === '+') setZoom(zoom * KEY_STEP);
    else if (e.key === '-' || e.key === '_') setZoom(zoom / KEY_STEP);
    else if (e.key === '0') setZoom(1);
    else return;
    e.preventDefault();
  });

  // Změna šířky okna nebo chatu: „přizpůsobit šířce“ se přepočítá, pevný zoom zůstane.
  new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!pages) return;
      layout(pages);
      scheduleSettle();
    }, 150);
  }).observe(body);
}
