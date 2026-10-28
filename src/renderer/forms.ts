import { CHARS_PER_PAGE, estimateCost } from '../shared/cost';
import { formatUsd } from '../shared/estimate';
import { locale, t, type MessageKey, type UiLangSetting } from '../shared/i18n';
import { activeRates, FAST_REMOTE_MODEL, isFreeModel, isOnline, RECOMMENDED_REMOTE_MODEL } from '../shared/provider';
import { catalogRows, filterCatalog, formatContext, isFree, sharedModel, sortCatalog, visionWarnings } from '../shared/catalog-view';
import type { Currency, GlossaryEntry, LmStatus, ModelPrice, Models, Settings, Theme } from '../shared/types';
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
  const [settings, lm, remote] = await Promise.all([window.api.getSettings(), window.api.lmStatus('local'), window.api.lmStatus('openrouter')]);
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

  const rerender = () => renderSettings(onSaved);
  const modelGroup = h(
    'section',
    { class: 'setting-group' },
    groupTitle(t('settings.local.title'), settings.provider === 'local'),
    localSummary(settings, lm),
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

  const r = activeRates(settings);
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
    ...(isOnline(settings) ? [remoteGroup(settings, remote, save, rerender), modelGroup] : [modelGroup, remoteGroup(settings, remote, save, rerender)]),
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

function groupTitle(text: string, active: boolean) {
  return h('h2', {}, text, active ? h('span', { class: 'chip accent in-use-now' }, t('settings.inUseNow')) : '');
}

function selectedCard(label: string, body: (Node | string)[], chips: Node[] = []) {
  return h(
    'div',
    { class: 'selected-model' },
    h('div', { class: 'engine-label' }, label),
    ...body,
    chips.length ? h('div', { class: 'chips' }, ...chips) : '',
  );
}

function localSummary(settings: Settings, lm: LmStatus) {
  const name = (key: string) => lm.models.find((m) => m.key === key)?.name ?? key;
  return selectedCard(
    t('settings.local.selected'),
    ROLES.map((role) => h('div', { class: 'selected-role' }, h('span', { class: 'selected-role-name' }, t(role.title)), h('span', { class: 'selected-model-name' }, name(settings.models[role.key])))),
  );
}

function remoteSummary(settings: Settings, lm: LmStatus) {
  const used = sharedModel(settings.remoteModels);
  const ids = [...new Set(ROLES.map((r) => settings.remoteModels[r.key]))];
  const found = ids.map((id) => lm.models.find((m) => m.key === id));
  const names = ids.map((id, i) => found[i]?.name ?? id).join(' + ');
  const chip = (text: string, cls = '') => h('span', { class: `chip ${cls}` }, text);
  const m = used ? found[0] : undefined;
  const chips: Node[] = [];
  if (found.length && found.every(Boolean)) {
    chips.push(found.every((f) => f!.vision) ? chip(t('settings.remote.vision')) : chip(t('settings.remote.noVisionTag'), 'warn'));
  }
  if (m?.price) chips.push(chip(isFree(m) ? t('settings.remote.free') : t('settings.remote.perM', { input: usd(m.price.input), output: usd(m.price.output) })));
  chips.push(
    lm.hasKey
      ? h('span', { class: 'chip ok' }, icon(ICONS.check), t('settings.remote.keyOk'))
      : h('span', { class: 'chip warn' }, icon(ICONS.alert), t('settings.remote.keyMissing')),
  );
  return selectedCard(t('settings.remote.selected'), [h('div', { class: 'selected-model-name big' }, names)], chips);
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

const price = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 3 });

function remoteLabel(m: LmStatus['models'][number]) {
  const tags = [
    m.price ? t('settings.remote.price', { input: price(m.price.input), output: price(m.price.output) }) : '',
    isFreeModel(m.key) ? t('settings.remote.free') : '',
    m.key === RECOMMENDED_REMOTE_MODEL ? t('settings.remote.recommended') : '',
    m.key === FAST_REMOTE_MODEL ? t('settings.remote.fast') : '',
  ].filter(Boolean);
  return [m.name, ...tags].join(' · ');
}

function currencySelect(settings: Settings, save: () => Promise<void>, rerender: () => Promise<void>) {
  const select = h('select');
  for (const value of ['both', 'czk', 'usd'] as Currency[]) {
    select.append(h('option', { value, selected: settings.currency === value }, t(`settings.currency.${value}`)));
  }
  select.addEventListener('change', async () => {
    settings.currency = select.value as Currency;
    await save();
    await rerender();
  });
  return h('label', { class: 'field' }, h('span', {}, t('settings.currency')), select);
}

function remoteGroup(settings: Settings, lm: LmStatus, save: () => Promise<void>, rerender: () => Promise<void>) {
  const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: lm.hasKey ? t('settings.remote.keyPlaceholderSaved') : t('settings.remote.keyPlaceholder') });
  const run = (action: () => Promise<void>) => async () => {
    try {
      await action();
      await rerender();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const saveKey = h('button', { class: 'btn', onclick: run(() => window.api.setApiKey(key.value)) }, t('settings.remote.keySave'));
  const removeKey = h('button', { class: 'btn danger', onclick: run(() => window.api.clearApiKey()) }, t('settings.remote.keyRemove'));
  const group = h(
    'section',
    { class: 'setting-group' },
    groupTitle(t('settings.remote.title'), settings.provider === 'openrouter'),
    remoteSummary(settings, lm),
    h('p', { class: 'warn-box' }, t('settings.remote.privacy')),
    h('label', { class: 'field' }, h('span', {}, t('settings.remote.key')), key),
    h('div', { class: 'row gap' }, saveKey, lm.hasKey ? removeKey : ''),
    h('p', { class: lm.hasKey ? 'ok-box' : 'warn-box' }, lm.hasKey ? t('settings.remote.keySaved') : t('settings.remote.keyNone')),
    currencySelect(settings, save, rerender),
  );
  if (!lm.models.length) {
    group.append(h('p', { class: 'error-box' }, t('settings.remote.noCatalog')));
    return group;
  }

  const prices = Object.fromEntries(lm.models.map((m) => [m.key, m.price]));
  const roleModels = () => Object.values(settings.remoteModels);
  const filter = h('input', { type: 'search', placeholder: t('settings.remote.filter') });
  const visionOnly = h('input', { type: 'checkbox' });
  visionOnly.checked = true;
  const warnings = h('div', { class: 'stack' });
  const table = h('div', { class: 'model-scroll' });
  const more = h('p', { class: 'muted small' });
  const cutoff = () => ({ text: filter.value, visionOnly: visionOnly.checked, keep: roleModels() });

  const selects = ROLES.map((role) => {
    const select = h('select');
    select.addEventListener('change', () => {
      settings.remoteModels[role.key] = select.value;
      void save().then(rerender);
    });
    const fillOne = () => {
      const current = settings.remoteModels[role.key];
      const options = sortCatalog(filterCatalog(lm.models, { text: filter.value, visionOnly: false, keep: [current] }));
      select.replaceChildren(
        ...(options.some((m) => m.key === current) ? [] : [h('option', { value: current, selected: true }, t('settings.modelMissing', { model: current }))]),
        ...options.map((m) => h('option', { value: m.key, selected: m.key === current }, remoteLabel(m))),
      );
    };
    const hint = role.vision ? ` (${t('settings.remote.visionHint')})` : '';
    return { fillOne, el: h('label', { class: 'field' }, h('span', {}, `${t(role.title)}${hint}`), select) };
  });

  const useModel = (id: string) => {
    for (const role of ROLES) settings.remoteModels[role.key] = id;
    void save().then(rerender);
  };
  const update = () => {
    const { rows, total } = catalogRows(lm.models, cutoff());
    const used = sharedModel(settings.remoteModels);
    table.replaceChildren(modelList(rows, used, useModel, (m) => sampleCost(m, settings, prices)));
    more.textContent = total > rows.length ? t('settings.remote.shown', { shown: rows.length, total }) : rows.length ? '' : t('settings.remote.noMatch');
    warnings.replaceChildren(
      ...visionWarnings(settings.remoteModels, lm.models).map(({ model }) => h('p', { class: 'warn-box' }, t('settings.remote.noVision', { model: lm.models.find((m) => m.key === model)?.name ?? model }))),
    );
    selects.forEach((x) => x.fillOne());
  };
  filter.addEventListener('input', update);
  visionOnly.addEventListener('change', update);
  update();

  const refresh = h(
    'button',
    {
      class: 'btn',
      onclick: run(async () => {
        refresh.disabled = true;
        await window.api.refreshCatalog();
      }),
    },
    t('settings.remote.refresh'),
  );
  const stamp = lm.catalogAt ? t('settings.remote.catalogAt', { date: new Date(lm.catalogAt).toLocaleString(locale()) }) : '';
  group.append(
    h('p', { class: 'muted small' }, t('settings.remote.info')),
    h('div', { class: 'row gap' }, refresh, h('span', { class: 'muted small' }, stamp)),
    h('div', { class: 'row gap' }, h('div', { class: 'grow' }, filter), h('label', { class: 'check' }, visionOnly, t('settings.remote.visionOnly'))),
    table,
    more,
    warnings,
    h('details', { class: 'role-models' }, h('summary', {}, t('settings.remote.custom')), ...selects.map((x) => x.el)),
  );
  if (Object.values(settings.remoteModels).some(isFreeModel)) group.append(h('p', { class: 'muted small' }, t('settings.remote.freeHint')));
  return group;
}

const usd = (n?: number) => (n === undefined ? '—' : price(n));

const SAMPLE_PAGES = 15;

/** Odhad ceny ukázkového dokumentu s tímto modelem ve všech rolích. */
function sampleCost(m: LmStatus['models'][number], settings: Settings, prices: Record<string, ModelPrice | undefined>) {
  const models = { ocr: m.key, translate: m.key, polish: m.key };
  const usd = estimateCost({ chars: SAMPLE_PAGES * CHARS_PER_PAGE, mode: settings.mode, models, prices }, settings.remoteCostFactors);
  return usd === undefined ? '' : t('settings.remote.estimate', { amount: formatUsd(usd), pages: SAMPLE_PAGES });
}

function modelList(rows: LmStatus['models'], used: string | undefined, onUse: (id: string) => void, sample: (m: LmStatus['models'][number]) => string) {
  const chip = (text: string, cls = '') => h('span', { class: `chip ${cls}` }, text);
  return h(
    'div',
    { class: 'model-list' },
    ...rows.map((m) => {
      const active = m.key === used;
      const cost = m.price && (isFree(m) ? t('settings.remote.free') : t('settings.remote.perM', { input: usd(m.price.input), output: usd(m.price.output) }));
      return h(
        'div',
        { class: `model-card${active ? ' active' : ''}` },
        h(
          'div',
          { class: 'model-info' },
          h('div', { class: 'model-name' }, m.name),
          h('div', { class: 'model-id' }, m.key),
          h(
            'div',
            { class: 'chips' },
            m.key === RECOMMENDED_REMOTE_MODEL ? chip(t('settings.remote.recommended'), 'accent') : '',
            m.key === FAST_REMOTE_MODEL ? chip(t('settings.remote.fast'), 'accent') : '',
            m.vision ? chip(t('settings.remote.vision')) : chip(t('settings.remote.noVisionTag'), 'warn'),
            m.context ? chip(t('settings.remote.context', { n: formatContext(m.context) })) : '',
            cost ? chip(cost) : '',
            !isFree(m) && sample(m) ? chip(sample(m)) : '',
          ),
        ),
        active
          ? h('span', { class: 'model-used' }, icon(ICONS.check), t('settings.remote.inUse'))
          : h('button', { class: 'btn', onclick: () => onUse(m.key) }, t('settings.remote.use')),
      );
    }),
  );
}
