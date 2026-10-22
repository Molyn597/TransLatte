import { afterEach, describe, expect, it } from 'vitest';
import { resolveLang, setLang, t } from '../src/shared/i18n';
import { cs } from '../src/shared/i18n/cs';
import { en } from '../src/shared/i18n/en';

const placeholders = (m: unknown) => [...JSON.stringify(m).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

describe('i18n', () => {
  afterEach(() => setLang('cs'));

  it('oba slovníky mají stejné klíče a parametry', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(cs).sort());
    for (const key of Object.keys(cs) as (keyof typeof cs)[]) expect([key, ...new Set(placeholders(en[key]))]).toEqual([key, ...new Set(placeholders(cs[key]))]);
  });

  it('dosadí parametry a přepne jazyk', () => {
    expect(t('settings.modelMissing', { model: 'x' })).toBe('x (nenalezen)');
    setLang('en');
    expect(t('settings.modelMissing', { model: 'x' })).toBe('x (not found)');
  });

  it('vybere tvar podle čísla', () => {
    const queued = (count: number) => t('home.queuedMany', { count });
    expect([1, 2, 5].map(queued)).toEqual(['Přidáno do fronty: 1 soubor', 'Přidáno do fronty: 2 soubory', 'Přidáno do fronty: 5 souborů']);
    setLang('en');
    expect([1, 2].map(queued)).toEqual(['Added to the queue: 1 file', 'Added to the queue: 2 files']);
  });

  it('jazyk podle systému', () => {
    expect(resolveLang('system', 'cs-CZ')).toBe('cs');
    expect(resolveLang('system', 'sk')).toBe('cs');
    expect(resolveLang('system', 'de-DE')).toBe('en');
    expect(resolveLang('en', 'cs-CZ')).toBe('en');
    expect(resolveLang(undefined, 'en-US')).toBe('en');
  });
});
