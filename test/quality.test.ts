import { describe, expect, it } from 'vitest';
import { glossaryMisses, hasRepetition, relevantGlossary, suspiciousLength, wordOverlap } from '../src/main/quality';

describe('wordOverlap', () => {
  const reference = 'Rapid urbanization has reduced the amount of natural space available to many people.';

  it('shodné texty mají plnou shodu', () => {
    expect(wordOverlap(reference, reference)).toEqual({ recall: 1, precision: 1 });
  });

  it('rozsypané OCR (z Apple Vision testu) má nízkou shodu', () => {
    const garbled = 'ped searchers have thered the men easily terested in everyday ontact';
    const { recall, precision } = wordOverlap(reference, garbled);
    expect(recall).toBeLessThan(0.85);
    expect(precision).toBeLessThan(0.85);
  });

  it('vynechaná věta sníží recall, ne precision', () => {
    const { recall, precision } = wordOverlap(`${reference} Another sentence follows here.`, reference);
    expect(precision).toBe(1);
    expect(recall).toBeLessThan(0.85);
  });
});

describe('hasRepetition', () => {
  it('pozná opakovaný řádek i frázi', () => {
    expect(hasRepetition(Array(5).fill('the same line').join('\n'))).toBe(true);
    expect(hasRepetition('and then it went on and on '.repeat(5))).toBe(true);
  });

  it('běžný text projde', () => {
    expect(hasRepetition('Participants completed an online questionnaire covering their weekly park visits.')).toBe(false);
  });
});

describe('suspiciousLength', () => {
  const source = 'Respondents who visited green spaces at least three times per week reported lower stress.';
  it('useknutý překlad je podezřelý', () => expect(suspiciousLength(source, 'Respondenti.')).toBe(true));
  it('přiměřený překlad ne', () =>
    expect(suspiciousLength(source, 'Respondenti, kteří navštěvovali zeleň alespoň třikrát týdně, hlásili méně stresu.')).toBe(false));
});

describe('glosář', () => {
  const glossary = [
    { source: 'large language model', target: 'velký jazykový model' },
    { source: 'fine-tuning', target: 'doladění' },
  ];

  it('termín ve skloněném tvaru se počítá jako použitý', () => {
    const misses = glossaryMisses(
      'We fine-tune a large language model.',
      'Doladíme velkého jazykového modelu.',
      glossary,
    );
    expect(misses).toEqual([]);
  });

  it('chybějící termín se nahlásí', () => {
    expect(glossaryMisses('The large language model works.', 'Velké LLM funguje.', glossary)).toEqual([glossary[0]]);
  });

  it('do promptu jdou jen termíny z odstavce', () => {
    expect(relevantGlossary('About fine-tuning only.', glossary)).toEqual([glossary[1]]);
  });
});
