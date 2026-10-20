import { describe, expect, it } from 'vitest';
import { isTranslateGemma, polishSystem, polishUser, translateGemmaPrompt } from '../src/main/prompts';

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

describe('polish prompty', () => {
  it('pro češtinu je prompt česky a obsahuje glosář', () => {
    const system = polishSystem('cs', [{ source: 'fine-tuning', target: 'doladění' }]);
    expect(system).toContain('český redaktor');
    expect(system).toContain('fine-tuning = doladění');
    expect(polishUser('A', 'B', 'cs')).toBe('ORIGINÁL:\nA\n\nPŘEKLAD:\nB');
  });

  it('pro jiné jazyky je prompt anglicky', () => {
    expect(polishSystem('de', [])).toContain('German editor');
    expect(polishSystem('de', [])).not.toContain('terminology');
  });
});
