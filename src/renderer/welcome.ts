import { t, type MessageKey } from '../shared/i18n';
import type { Provider, Settings } from '../shared/types';
import { h, icon, ICONS } from './dom';

interface WelcomeContext {
  settings: () => Settings;
  /** Uloží nastavení a po změně poskytovatele překreslí úvodní stránku. */
  setProvider: (p: Provider) => Promise<void>;
  save: () => Promise<void>;
  openSettings: () => void;
}

const STEPS = 3;

// Dlaždice s ikonou nebo číslem kroku, nadpisem a krátkým popisem.
const tile = (mark: Node | string, title: MessageKey, text: MessageKey) =>
  h('div', { class: 'welcome-tile' }, h('span', { class: 'welcome-mark' }, mark), h('strong', {}, t(title)), h('span', { class: 'muted small' }, t(text)));

/** Úvodní průvodce o třech krocích; Přeskočit i Začít ho označí jako zobrazený. */
export function openWelcome(ctx: WelcomeContext) {
  const root = document.getElementById('welcome')!;
  let step = 1;
  let hasKey: boolean | undefined;

  const finish = async () => {
    root.hidden = true;
    root.replaceChildren();
    document.removeEventListener('keydown', onKey);
    const settings = ctx.settings();
    if (!settings.onboarded) {
      settings.onboarded = true;
      await ctx.save();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') void finish();
  };
  document.addEventListener('keydown', onKey);
  void window.api.hasApiKey().then((k) => {
    hasKey = k;
    if (step === 2) render();
  });

  const render = () => {
    const body: (Node | string)[] = [
      h('div', { class: 'welcome-step' }, t('welcome.step', { step, total: STEPS })),
      h('h2', {}, t(`welcome.${step as 1}.title`)),
    ];
    if (step === 1) {
      body.push(
        h('p', {}, t('welcome.1.text')),
        h(
          'div',
          { class: 'welcome-tiles' },
          tile(icon(ICONS.file), 'welcome.1.layout', 'welcome.1.layoutText'),
          tile(icon(ICONS.list), 'welcome.1.scans', 'welcome.1.scansText'),
          tile(icon(ICONS.balanced), 'welcome.1.choice', 'welcome.1.choiceText'),
        ),
      );
    }
    if (step === 2) {
      const settings = ctx.settings();
      body.push(
        h('p', {}, t('welcome.2.text')),
        h(
          'div',
          { class: 'provider-switch', role: 'radiogroup' },
          ...(['local', 'openrouter'] as Provider[]).map((p) =>
            h(
              'button',
              {
                class: settings.provider === p ? 'provider active' : 'provider',
                role: 'radio',
                'aria-checked': String(settings.provider === p),
                onclick: async () => {
                  await ctx.setProvider(p);
                  render();
                },
              },
              h('span', { class: 'provider-title' }, t(`home.provider.${p}`)),
              h('span', { class: 'provider-desc' }, t(`home.provider.${p}Desc`)),
            ),
          ),
        ),
      );
      if (settings.provider === 'openrouter' && hasKey === false) {
        body.push(
          h('p', { class: 'muted' }, t('welcome.2.noKey')),
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                await finish();
                ctx.openSettings();
              },
            },
            t('welcome.2.openSettings'),
          ),
        );
      }
    }
    if (step === 3) {
      body.push(
        h(
          'div',
          { class: 'welcome-tiles' },
          tile('1', 'welcome.3.add', 'welcome.3.addText'),
          tile('2', 'welcome.3.set', 'welcome.3.setText'),
          tile('3', 'welcome.3.go', 'welcome.3.goText'),
        ),
        h('p', { class: 'muted small' }, t('welcome.3.help')),
      );
    }
    body.push(
      h(
        'div',
        { class: 'welcome-foot' },
        h('button', { class: 'btn', onclick: () => void finish() }, t('welcome.skip')),
        h('span', { class: 'spacer' }),
        h('div', { class: 'welcome-dots' }, ...Array.from({ length: STEPS }, (_, i) => h('i', { class: i + 1 === step ? 'on' : '' }))),
        step > 1 ? h('button', { class: 'btn', onclick: () => (step--, render()) }, t('welcome.back')) : '',
        step < STEPS
          ? h('button', { class: 'btn primary', onclick: () => (step++, render()) }, t('welcome.next'))
          : h('button', { class: 'btn primary', onclick: () => void finish() }, t('welcome.start')),
      ),
    );
    root.replaceChildren(h('div', { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('welcome.1.title') }, ...body));
  };

  root.hidden = false;
  render();
}
