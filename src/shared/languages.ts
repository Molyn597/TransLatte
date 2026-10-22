import { getLang } from './i18n';

// Jazyky, které TranslateGemma podporuje a které nabízíme v UI (kód ISO 639-1).
export const LANGUAGES: { code: string; name: string; english: string }[] = [
  { code: 'cs', name: 'čeština', english: 'Czech' },
  { code: 'sk', name: 'slovenština', english: 'Slovak' },
  { code: 'en', name: 'angličtina', english: 'English' },
  { code: 'de', name: 'němčina', english: 'German' },
  { code: 'fr', name: 'francouzština', english: 'French' },
  { code: 'es', name: 'španělština', english: 'Spanish' },
  { code: 'it', name: 'italština', english: 'Italian' },
  { code: 'pl', name: 'polština', english: 'Polish' },
  { code: 'uk', name: 'ukrajinština', english: 'Ukrainian' },
  { code: 'ru', name: 'ruština', english: 'Russian' },
  { code: 'pt', name: 'portugalština', english: 'Portuguese' },
  { code: 'nl', name: 'nizozemština', english: 'Dutch' },
  { code: 'hu', name: 'maďarština', english: 'Hungarian' },
  { code: 'ro', name: 'rumunština', english: 'Romanian' },
  { code: 'hr', name: 'chorvatština', english: 'Croatian' },
  { code: 'sl', name: 'slovinština', english: 'Slovenian' },
  { code: 'bg', name: 'bulharština', english: 'Bulgarian' },
  { code: 'el', name: 'řečtina', english: 'Greek' },
  { code: 'sv', name: 'švédština', english: 'Swedish' },
  { code: 'da', name: 'dánština', english: 'Danish' },
  { code: 'fi', name: 'finština', english: 'Finnish' },
  { code: 'no', name: 'norština', english: 'Norwegian' },
  { code: 'tr', name: 'turečtina', english: 'Turkish' },
  { code: 'ja', name: 'japonština', english: 'Japanese' },
  { code: 'zh', name: 'čínština', english: 'Chinese' },
  { code: 'ko', name: 'korejština', english: 'Korean' },
];

/** Název jazyka v jazyce rozhraní. */
export const languageName = (code: string) => {
  const language = LANGUAGES.find((l) => l.code === code);
  return language ? (getLang() === 'en' ? language.english : language.name) : code;
};
export const englishName = (code: string) => LANGUAGES.find((l) => l.code === code)?.english ?? code;
export const isSupported = (code: string) => LANGUAGES.some((l) => l.code === code);
