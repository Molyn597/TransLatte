// Jazyk rozhraní: čeština a angličtina. Klíče jsou v cs.ts, en.ts musí mít stejné (hlídá to typ i test).
import { cs } from './cs';
import { en } from './en';

export type UiLang = 'cs' | 'en';
export type UiLangSetting = 'system' | UiLang;
/** Text, nebo tvary podle čísla (Intl.PluralRules: one/few/many/other) pro parametr `count`. */
export type Message = string | Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type MessageKey = keyof typeof cs;

const DICTIONARIES: Record<UiLang, Record<MessageKey, Message>> = { cs, en };

let current: UiLang = 'cs';

/** „Podle systému“: čeština na českém (a slovenském) systému, jinak angličtina. */
export const resolveLang = (setting: UiLangSetting | undefined, locale: string): UiLang =>
  setting && setting !== 'system' ? setting : /^(cs|sk)\b/i.test(locale) ? 'cs' : 'en';

export const setLang = (lang: UiLang) => (current = lang);
export const getLang = () => current;
/** Locale pro formátování data a čísel. */
export const locale = () => (current === 'cs' ? 'cs-CZ' : 'en-GB');

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const message = DICTIONARIES[current][key] ?? cs[key];
  const text =
    typeof message === 'string' ? message : (message[new Intl.PluralRules(locale()).select(Number(params.count ?? 0))] ?? message.other);
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));
}
