import { t } from '../shared/i18n';
import type { UpdateCheck, UpdateProgress } from '../shared/types';
import { h } from './dom';

type Latest = NonNullable<UpdateCheck['latest']>;

let onProgress: ((p: UpdateProgress) => void) | null = null;

/** Karta „Je k dispozici nová verze“: změny, stažení s průběhem a po stažení další krok podle systému. */
export function updateCard(latest: Latest, onLater?: () => void) {
  if (!onProgress) window.api.onUpdateProgress((p) => onProgress?.(p));

  const message = h('p', { class: 'update-msg' }, '');
  message.hidden = true;
  const notes = h('pre', { class: 'update-notes' }, latest.notes || t('update.noNotes'));
  notes.hidden = true;
  const toggle = h('button', { class: 'link', type: 'button', 'aria-expanded': 'false' }, t('update.whatsNew'));
  toggle.addEventListener('click', () => {
    notes.hidden = !notes.hidden;
    toggle.setAttribute('aria-expanded', String(!notes.hidden));
  });
  const install = h('button', { class: 'btn primary', type: 'button' }, t('update.install'));
  const actions = h('div', { class: 'update-actions' }, install);
  if (onLater) actions.append(h('button', { class: 'btn', type: 'button', onclick: onLater }, t('update.later')));

  const say = (text: string, error = false) => {
    message.textContent = text;
    message.className = error ? 'update-msg error' : 'update-msg';
    message.hidden = false;
  };

  install.addEventListener('click', async () => {
    install.disabled = true;
    message.hidden = true;
    const label = (percent?: number) => (install.textContent = percent === undefined ? t('update.downloading') : t('update.downloadingPercent', { percent }));
    label();
    onProgress = (p) => label(p.total > 0 ? Math.min(100, Math.floor((p.received / p.total) * 100)) : undefined);
    const r = await window.api.downloadUpdate().catch((e: Error) => ({ ok: false as const, error: e.message, url: latest.url }));
    onProgress = null;
    if (!r.ok) {
      install.textContent = t('update.install');
      install.disabled = false;
      say(t('update.error', { error: r.error }), true);
      actions.append(h('button', { class: 'btn', type: 'button', onclick: () => void window.api.openUrl(r.url ?? latest.url) }, t('update.openRelease')));
      return;
    }
    install.hidden = true;
    if (r.platform === 'windows') return say(t('update.installing'));
    say(t('update.macStep'));
    actions.append(h('button', { class: 'btn primary', type: 'button', onclick: () => void window.api.quitApp() }, t('update.quit')));
  });

  return h(
    'div',
    { class: 'update-card' },
    h('div', { class: 'update-head' }, h('strong', {}, t('update.available', { version: latest.version })), toggle),
    notes,
    message,
    actions,
  );
}
