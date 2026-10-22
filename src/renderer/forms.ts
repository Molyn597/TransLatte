import { t, type MessageKey, type UiLangSetting } from '../shared/i18n';
import type { GlossaryEntry, LmStatus, Models, Settings, Theme } from '../shared/types';
import { duration, h, icon, ICONS, toast } from './dom';

const $ = (id: string) => document.getElementById(id)!;

// ---------- Glosář ----------

let entries: GlossaryEntry[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave() {
  clearTimeout(saveTimer);
  $('glossary-saved').textContent = t('glossary.saving');
  saveTimer = setTimeout(async () => {
    await window.api.saveGlossary(entries);
    $('glossary-saved').textContent = t('glossary.saved');
  }, 500);
}

function glossaryRow(entry: GlossaryEntry) {
  const input = (key: keyof GlossaryEntry, placeholder: string) => {
    const el = h('input', { type: 'text', placeholder });
    el.value = entry[key];
    el.addEventListener('input', () => {
      entry[key] = el.value;
      scheduleSave();
    });
    return el;
  };
  const row = h(
    'div',
    { class: 'glossary-row' },
    input('source', t('glossary.sourcePlaceholder')),
    icon(ICONS.arrow),
    input('target', t('glossary.targetPlaceholder')),
    h(
      'button',
      {
        class: 'circle-btn',
        title: t('glossary.remove'),
        onclick: () => {
          entries = entries.filter((e) => e !== entry);
          row.remove();
          scheduleSave();
        },
      },
      icon(ICONS.trash),
    ),
  );
  return row;
}

export async function renderGlossary() {
  entries = await window.api.getGlossary();
  if (!entries.length) entries.push({ source: '', target: '' });
  $('glossary').replaceChildren(...entries.map(glossaryRow));
  $('glossary-saved').textContent = '';
}

export function setupGlossary() {
  $('glossary-add').addEventListener('click', () => {
    const entry = { source: '', target: '' };
    entries.push(entry);
    const row = glossaryRow(entry);
    $('glossary').append(row);
    row.querySelector('input')?.focus();
  });
}

// ---------- Nastavení ----------

const ROLES: { key: keyof Models; title: MessageKey; hint: MessageKey; vision?: boolean }[] = [
  { key: 'ocr', title: 'settings.role.ocr', hint: 'settings.role.ocrHint', vision: true },
  { key: 'translate', title: 'settings.role.translate', hint: 'settings.role.translateHint' },
  { key: 'polish', title: 'settings.role.polish', hint: 'settings.role.polishHint' },
];

const gb = (bytes: number) => (bytes ? ` · ${(bytes / 1e9).toFixed(1)} GB` : '');

function toggle(label: string, hint: string, checked: boolean, onChange: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, h('span', {}, h('div', {}, label), h('div', { class: 'muted small' }, hint)), input);
}

export async function renderSettings(onSaved: (s: Settings) => void) {
  const [settings, lm] = await Promise.all([window.api.getSettings(), window.api.lmStatus()]);
  const save = async () => {
    await window.api.saveSettings(settings);
    onSaved(settings);
    toast(t('settings.saved'));
  };

  const url = h('input', { type: 'url' });
  url.value = settings.apiUrl;
  url.addEventListener('change', () => {
    settings.apiUrl = url.value.replace(/\/+$/, '') || 'http://localhost:1234';
    void save();
  });

  const modelGroup = h(
    'section',
    { class: 'setting-group' },
    h('h2', {}, 'LM Studio'),
    h('label', { class: 'field' }, h('span', {}, t('settings.serverUrl')), url),
  );
  for (const role of ROLES) modelGroup.append(modelSelect(role, settings, lm, save));
  if (!lm.cli) {
    modelGroup.append(
      h('p', { class: 'error-box' }, t('settings.noCli')),
    );
  }

  const theme = h('select');
  for (const value of ['system', 'light', 'dark', 'mono'] as Theme[]) {
    theme.append(h('option', { value, selected: settings.theme === value }, t(`settings.theme.${value}`)));
  }
  theme.addEventListener('change', () => {
    settings.theme = theme.value as Theme;
    void save();
  });

  // Názvy jazyků vždy ve vlastním jazyce, aby šel najít i po omylem přepnutém jazyce.
  const uiLang = h('select');
  for (const [value, label] of [
    ['system', t('settings.uiLang.system')],
    ['cs', 'Čeština'],
    ['en', 'English'],
  ] as [UiLangSetting, string][]) {
    uiLang.append(h('option', { value, selected: settings.uiLang === value }, label));
  }
  uiLang.addEventListener('change', async () => {
    settings.uiLang = uiLang.value as UiLangSetting;
    await window.api.saveSettings(settings);
    location.reload();
  });

  const r = settings.rates;
  const rates = h(
    'section',
    { class: 'setting-group' },
    h('h2', {}, t('settings.rates')),
    h(
      'p',
      { class: 'muted small' },
      t('settings.ratesText', { ocr: duration(r.ocrPerPage), translate: duration(r.translatePerKChar), fix: duration(r.fixPerSegment) }),
    ),
  );

  $('settings').replaceChildren(
    modelGroup,
    h(
      'section',
      { class: 'setting-group' },
      h('h2', {}, t('settings.app')),
      h('label', { class: 'field' }, h('span', {}, 'Jazyk aplikace / App language'), uiLang),
      toggle(t('settings.notify'), t('settings.notifyHint'), settings.notify, (v) => {
        settings.notify = v;
        void save();
      }),
      toggle(t('settings.layoutPdf'), t('settings.layoutPdfHint'), settings.layoutPdf, (v) => {
        settings.layoutPdf = v;
        void save();
      }),
      toggle(t('settings.unload'), t('settings.unloadHint'), settings.unloadWhenIdle, (v) => {
        settings.unloadWhenIdle = v;
        void save();
      }),
      h('label', { class: 'field' }, h('span', {}, t('settings.theme')), theme),
    ),
    rates,
  );
}

function modelSelect(
  role: (typeof ROLES)[number],
  settings: Settings,
  lm: LmStatus,
  save: () => Promise<void>,
) {
  const select = h('select');
  const options = lm.models.filter((m) => !role.vision || m.vision);
  if (!options.some((m) => m.key === settings.models[role.key])) {
    select.append(h('option', { value: settings.models[role.key], selected: true }, t('settings.modelMissing', { model: settings.models[role.key] })));
  }
  for (const m of options) {
    select.append(h('option', { value: m.key, selected: m.key === settings.models[role.key] }, `${m.name}${gb(m.sizeBytes)}`));
  }
  select.addEventListener('change', () => {
    settings.models[role.key] = select.value;
    void save();
  });
  return h('label', { class: 'field' }, h('span', {}, `${t(role.title)} – ${t(role.hint)}`), select);
}
