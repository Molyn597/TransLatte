import { englishName } from '../shared/languages';
import type { DocumentContext, GlossaryEntry } from '../shared/types';

export const OCR_PROMPT = 'Convert the document to markdown.';

export const TABLE_PROMPT =
  'Transcribe this table exactly as a Markdown table (| separators, header separator row). ' +
  'Keep the original language and all values. Output only the table.';

export const regionPrompt = (target: string) =>
  `Transcribe all text in this image and translate it into ${englishName(target)}. ` +
  `Translate every title, axis label, legend entry and caption (a figure caption starts with the word for "Figure"); ` +
  `keep numbers, years and proper names. Keep the reading order and line structure; render a table as a Markdown table. ` +
  `Output only the ${englishName(target)} translation, without comments. If there is no text, output nothing.`;

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

const GENDER_CS = { female: 'žena', male: 'muž', unknown: 'neznámý' };

// Termíny z kontextu se korektorovi nepředávají, model je generuje nespolehlivě.
function contextLines(context: DocumentContext | undefined, target: string) {
  if (!context) return [];
  const cs = target === 'cs';
  const lines = [];
  if (context.topic) lines.push(`${cs ? 'Téma' : 'Topic'}: ${context.topic}`);
  if (context.domain) lines.push(`${cs ? 'Obor' : 'Domain'}: ${context.domain}`);
  if (context.author || context.authorGender !== 'unknown') {
    const gender = cs ? GENDER_CS[context.authorGender] : context.authorGender;
    lines.push(`${cs ? 'Autor' : 'Author'}: ${context.author || (cs ? 'neuveden' : 'not stated')} (${cs ? 'rod' : 'gender'}: ${gender})`);
  }
  return lines;
}

/** Korektor opravuje jen nalezené problémy; celotextové uhlazení přidávalo nové chyby. */
export function fixSystem(target: string, glossary: GlossaryEntry[], context?: DocumentContext) {
  const cs = target === 'cs';
  const parts = [
    cs
      ? 'Jsi korektor překladů. Oprav POUZE uvedené problémy, vše ostatní ponech beze změny slovo od slova. Vrať jen opravený text.'
      : 'You are a translation proofreader. Fix ONLY the listed problems, keep everything else unchanged word for word. Output only the corrected text.',
  ];
  const ctx = contextLines(context, target);
  if (ctx.length) parts.push(`${cs ? 'Kontext dokumentu' : 'Document context'}:\n${ctx.join('\n')}`);
  if (glossary.length) {
    parts.push(
      `${cs ? 'Závazná terminologie (použij ji ve správném tvaru)' : 'Mandatory terminology (use it in the grammatically correct form)'}:\n${glossaryLines(glossary)}`,
    );
  }
  return parts.join('\n\n');
}

export function fixUser(source: string, translation: string, problems: string[], target: string) {
  const [o, t, p] = target === 'cs' ? ['ORIGINÁL', 'PŘEKLAD', 'PROBLÉMY'] : ['ORIGINAL', 'TRANSLATION', 'PROBLEMS'];
  return `${o}:\n${source}\n\n${t}:\n${translation}\n\n${p}:\n${problems.map((x) => `- ${x}`).join('\n')}`;
}

export function contextPrompt(sample: string, target: string) {
  return (
    'Read the beginning of the document below and describe it as JSON only, without any other text:\n' +
    '{"topic": "...", "domain": "...", "author": "...", "authorGender": "female" | "male" | "unknown", ' +
    '"audience": "...", "terms": [{"source": "...", "target": "..."}]}\n' +
    `Write topic, domain and audience in ${englishName(target)}. author is the author's name as written, or "" when unknown. ` +
    'authorGender is the gender of the author writing in the first person; use "unknown" when it is not clear. ' +
    `terms are up to 15 key technical terms exactly as written in the document, with their usual ${englishName(target)} translation as target.` +
    `\n\nDOCUMENT:\n${sample}`
  );
}
