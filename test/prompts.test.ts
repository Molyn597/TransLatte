import { describe, expect, it } from 'vitest';
import { contextPrompt, fixSystem, fixUser, isTranslateGemma, translateGemmaPrompt } from '../src/main/prompts';

describe('translateGemmaPrompt', () => {
  it('odpovídá oficiální šabloně TranslateGemma', () => {
    const prompt = translateGemmaPrompt('  Hello world.  ', 'en', 'cs');
    expect(prompt).toBe(
      '<start_of_turn>user\nYou are a professional English (en) to Czech (cs) translator. Your goal is to accurately ' +
        'convey the meaning and nuances of the original English text while adhering to Czech grammar, vocabulary, and ' +
        'cultural sensitivities.\nProduce only the Czech translation, without any additional explanations or commentary. ' +
        'Please translate the following English text into Czech:\n\n\nHello world.<end_of_turn>\n<start_of_turn>model\n',
    );
  });

  it('rozpozná model TranslateGemma podle klíče', () => {
    expect(isTranslateGemma('translategemma-12b-it')).toBe(true);
    expect(isTranslateGemma('google/gemma-4-12b-qat')).toBe(false);
  });
});

describe('prompty korektora', () => {
  const context = {
    topic: 'Řízení týmů',
    domain: 'HR',
    author: 'Jana Nováková',
    authorGender: 'female' as const,
    audience: '',
    terms: [{ source: 'Check-in', target: 'Check-in (běžné zpětné vazby)' }],
  };

  it('pro češtinu česky s kontextem a glosářem', () => {
    const system = fixSystem('cs', [{ source: 'fine-tuning', target: 'doladění' }], context);
    expect(system).toContain(
      'Jsi korektor překladů. Oprav POUZE uvedené problémy, vše ostatní ponech beze změny slovo od slova. Vrať jen opravený text.',
    );
    expect(system).toContain('Téma: Řízení týmů\nObor: HR\nAutor: Jana Nováková (rod: žena)');
    expect(system).toContain('fine-tuning = doladění');
    expect(system).not.toContain('běžné zpětné vazby');
    expect(fixUser('A', 'B', ['Překlep: x.', 'Chybí termín.'], 'cs')).toBe(
      'ORIGINÁL:\nA\n\nPŘEKLAD:\nB\n\nPROBLÉMY:\n- Překlep: x.\n- Chybí termín.',
    );
  });

  it('pro jiné jazyky anglicky, bez kontextu a glosáře jen zadání', () => {
    expect(fixSystem('de', [])).toBe(
      'You are a translation proofreader. Fix ONLY the listed problems, keep everything else unchanged word for word. Output only the corrected text.',
    );
    expect(fixSystem('de', [], { ...context, author: '' })).toContain('Author: not stated (gender: female)');
    expect(fixUser('A', 'B', ['x'], 'de')).toBe('ORIGINAL:\nA\n\nTRANSLATION:\nB\n\nPROBLEMS:\n- x');
  });

  it('kontext chce JSON s termíny v cílovém jazyce', () => {
    const prompt = contextPrompt('Text.', 'cs');
    expect(prompt).toContain('"authorGender": "female" | "male" | "unknown"');
    expect(prompt).toContain('usual Czech translation');
    expect(prompt.endsWith('DOCUMENT:\nText.')).toBe(true);
  });
});
