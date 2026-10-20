import { englishName } from '../shared/languages';
import type { GlossaryEntry } from '../shared/types';

export const OCR_PROMPT = 'Convert the document to markdown.';

export const TABLE_PROMPT =
  'Transcribe this table exactly as a Markdown table (| separators, header separator row). ' +
  'Keep the original language and all values. Output only the table.';

/** TranslateGemma má pevnou šablonu; chat API by její strukturovaný vstup rozbilo, proto raw prompt. */
export function translateGemmaPrompt(text: string, source: string, target: string) {
  const src = englishName(source);
  const tgt = englishName(target);
  return (
    `<start_of_turn>user\nYou are a professional ${src} (${source}) to ${tgt} (${target}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${src} text while adhering to ` +
    `${tgt} grammar, vocabulary, and cultural sensitivities.\nProduce only the ${tgt} translation, without any ` +
    `additional explanations or commentary. Please translate the following ${src} text into ${tgt}:\n\n\n` +
    `${text.trim()}<end_of_turn>\n<start_of_turn>model\n`
  );
}

export const isTranslateGemma = (modelKey: string) => /translategemma/i.test(modelKey);

/** Pro jiné překladové modely než TranslateGemma (chat API). */
export function translateSystem(source: string, target: string) {
  return (
    `You are a professional ${englishName(source)} to ${englishName(target)} translator. Translate the user's text ` +
    `faithfully. Keep paragraph breaks (blank lines), lists and Markdown tables exactly as they are. ` +
    `Output only the translation, without any comments.`
  );
}

function glossaryLines(glossary: GlossaryEntry[]) {
  return glossary.map((g) => `${g.source} = ${g.target}`).join('\n');
}

export function polishSystem(target: string, glossary: GlossaryEntry[]) {
  const terms = glossary.length ? glossaryLines(glossary) : '';
  if (target === 'cs') {
    return (
      'Jsi zkušený český redaktor odborných textů. Dostaneš originál a jeho strojový překlad do češtiny. ' +
      'Uprav překlad do přirozené, plynulé a gramaticky správné češtiny. Oprav chyby ve významu podle originálu. ' +
      'Nic nepřidávej ani nevynechávej. Zachovej odstavce (prázdné řádky), seznamy i tabulky. ' +
      'Vrať pouze upravený český text bez komentářů.' +
      (terms ? `\n\nZávazná terminologie (použij ji ve správném tvaru):\n${terms}` : '')
    );
  }
  const lang = englishName(target);
  return (
    `You are an experienced ${lang} editor of technical texts. You get an original and its machine translation into ` +
    `${lang}. Rewrite the translation into natural, fluent and grammatically correct ${lang} and fix meaning errors ` +
    `using the original. Do not add or omit anything. Keep paragraphs (blank lines), lists and tables. ` +
    `Output only the edited ${lang} text without comments.` +
    (terms ? `\n\nMandatory terminology (use it in the grammatically correct form):\n${terms}` : '')
  );
}

export function polishUser(source: string, translation: string, target: string) {
  return target === 'cs'
    ? `ORIGINÁL:\n${source}\n\nPŘEKLAD:\n${translation}`
    : `ORIGINAL:\n${source}\n\nTRANSLATION:\n${translation}`;
}
