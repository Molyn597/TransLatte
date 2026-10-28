import { getLang, t, type MessageKey } from '../shared/i18n';
import { helpSections, type HelpTopic } from '../shared/help';
import { toast, h } from './dom';

/** Obsah sekce „Nápověda“: odkazy na kapitoly a kapitoly samotné (text je z shared/help.ts). */
export function renderHelp(onWelcome: () => void) {
  const sections = helpSections(getLang());
  document.getElementById('help-toc')!.replaceChildren(
    ...sections.map((s) => h('a', { role: 'link', tabindex: '0', onclick: () => scrollToTopic(s.id) }, s.title)),
  );
  document.getElementById('help-body')!.replaceChildren(
    ...sections.map((s) => {
      const section = h(
        'section',
        { class: 'help-section', id: `help-${s.id}` },
        h('h2', {}, s.title),
        ...s.blocks.map((b) =>
          'p' in b ? h('p', {}, b.p) : 'tip' in b ? h('p', { class: 'help-tip' }, b.tip) : list(b.ul),
        ),
      );
      if (s.id === 'about') section.append(aboutActions(onWelcome));
      return section;
    }),
  );
}

function aboutActions(onWelcome: () => void) {
  const version = h('p', { class: 'muted' }, t('help.version', { version: '…' }));
  void window.api.appVersion().then((v) => (version.textContent = t('help.version', { version: v })));
  const check = h('button', { class: 'btn' }, t('help.checkUpdate'));
  check.addEventListener('click', async () => {
    check.disabled = true;
    try {
      const r = await window.api.checkUpdate();
      toast(!r.ok ? t('update.failed') : r.newer ? t('update.available', { version: r.latest!.version }) : t('update.latest'), !r.ok);
    } catch {
      toast(t('update.failed'), true);
    } finally {
      check.disabled = false;
    }
  });
  return h('div', {}, version, h('div', { class: 'help-actions' }, check, h('button', { class: 'btn', onclick: onWelcome }, t('help.showWelcome'))));
}

export function scrollToTopic(topic: HelpTopic) {
  document.getElementById(`help-${topic}`)?.scrollIntoView({ block: 'start' });
}

/** Malé „?“ s tipem; klik otevře příslušnou kapitolu a nespustí okolní label/checkbox. */
// Kroky „1. …“ jako číslovaný seznam, ne odrážky s čísly.
export const list = (items: string[]) =>
  items.every((li) => /^\d+\.\s/.test(li))
    ? h('ol', {}, ...items.map((li) => h('li', {}, li.replace(/^\d+\.\s/, ''))))
    : h('ul', {}, ...items.map((li) => h('li', {}, li)));

export function fillHelpDots(open: (topic: HelpTopic) => void) {
  for (const slot of document.querySelectorAll<HTMLElement>('.help-slot')) {
    const hint = t(slot.dataset.hint as MessageKey);
    slot.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: 'help-dot',
          title: hint,
          'aria-label': t('help.dot'),
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            open(slot.dataset.help as HelpTopic);
          },
        },
        '?',
      ),
    );
  }
}
