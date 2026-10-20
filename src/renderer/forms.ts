import type { GlossaryEntry, LmStatus, Models, Settings, Theme } from '../shared/types';
import { duration, h, icon, ICONS, toast } from './dom';

const $ = (id: string) => document.getElementById(id)!;

// ---------- Glosář ----------

let entries: GlossaryEntry[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave() {
  clearTimeout(saveTimer);
  $('glossary-saved').textContent = 'Ukládám…';
  saveTimer = setTimeout(async () => {
    await window.api.saveGlossary(entries);
    $('glossary-saved').textContent = 'Uloženo';
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
    input('source', 'Termín v originálu, např. large language model'),
    icon(ICONS.arrow),
    input('target', 'Překlad, např. velký jazykový model'),
    h(
      'button',
      {
        class: 'circle-btn',
        title: 'Odebrat',
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

const ROLES: { key: keyof Models; title: string; hint: string; vision?: boolean }[] = [
  { key: 'ocr', title: 'OCR (čtení stránek)', hint: 'Vision model, doporučený Unlimited-OCR.', vision: true },
  { key: 'translate', title: 'Překlad', hint: 'Doporučená TranslateGemma.' },
  { key: 'polish', title: 'Uhlazení a glosář', hint: 'Obecný model, doporučená Gemma 4.' },
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
    toast('Nastavení uloženo');
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
    h('label', { class: 'field' }, h('span', {}, 'Adresa serveru'), url),
  );
  for (const role of ROLES) modelGroup.append(modelSelect(role, settings, lm, save));
  if (!lm.cli) {
    modelGroup.append(
      h('p', { class: 'error-box' }, 'Příkaz „lms“ z LM Studia se nenašel. Nainstaluj LM Studio a jednou ho spusť; modely pak půjde vybrat tady.'),
    );
  }

  const theme = h('select');
  for (const [value, label] of [['system', 'Podle systému'], ['light', 'Světlý'], ['dark', 'Tmavý']] as [Theme, string][]) {
    theme.append(h('option', { value, selected: settings.theme === value }, label));
  }
  theme.addEventListener('change', () => {
    settings.theme = theme.value as Theme;
    void save();
  });

  const r = settings.rates;
  const rates = h(
    'section',
    { class: 'setting-group' },
    h('h2', {}, 'Odhad času'),
    h(
      'p',
      { class: 'muted small' },
      `Zpřesňuje se podle tvých překladů. Teď: OCR ${duration(r.ocrPerPage)} na stránku, překlad ${duration(r.translatePerKChar)} a uhlazení ${duration(r.polishPerKChar)} na 1000 znaků.`,
    ),
  );

  $('settings').replaceChildren(
    modelGroup,
    h(
      'section',
      { class: 'setting-group' },
      h('h2', {}, 'Aplikace'),
      toggle('Oznámení po dokončení', 'Systémová notifikace, když je překlad hotový nebo selže.', settings.notify, (v) => {
        settings.notify = v;
        void save();
      }),
      toggle('Uvolnit modely po dokončení', 'Po poslední úloze se modely vyhodí z paměti a uvolní RAM.', settings.unloadWhenIdle, (v) => {
        settings.unloadWhenIdle = v;
        void save();
      }),
      h('label', { class: 'field' }, h('span', {}, 'Vzhled'), theme),
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
    select.append(h('option', { value: settings.models[role.key], selected: true }, `${settings.models[role.key]} (nenalezen)`));
  }
  for (const m of options) {
    select.append(h('option', { value: m.key, selected: m.key === settings.models[role.key] }, `${m.name}${gb(m.sizeBytes)}`));
  }
  select.addEventListener('change', () => {
    settings.models[role.key] = select.value;
    void save();
  });
  return h('label', { class: 'field' }, h('span', {}, `${role.title} – ${role.hint}`), select);
}
