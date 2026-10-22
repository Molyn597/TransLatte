import { describe, expect, it } from 'vitest';
import { findAnchors, glossaryMisses, hasRepetition, relevantGlossary, suspiciousLength, wordOverlap } from '../src/main/quality';

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

describe('odkazy v překladu', () => {
  const at = (text: string, r: { start: number; end: number } | null) => (r ? text.slice(r.start, r.end) : null);

  it('najde přeložený text odkazu i ve skloněném tvaru a bez interpunkce', () => {
    const text = 'Podle zprávy společnosti Bersin by Deloitte, kterou cituje článek, o tom rozhodují manažeři.';
    const [name] = findAnchors(text, [{ source: 'Bersin by Deloitte', target: 'Bersin by Deloitte' }], 'x');
    expect(at(text, name)).toBe('Bersin by Deloitte');
    const declined = 'Zrušili jsme tradiční hodnocení výkonu a zavedli novou praxi.';
    const [review] = findAnchors(declined, [{ source: 'performance review', target: 'tradiční hodnocení výkonu' }], 'x');
    expect(at(declined, review)).toBe('tradiční hodnocení výkonu');
    const [stem] = findAnchors('Přečtěte si naši webovou stránku.', [{ source: 'our website', target: 'naše webová stránka' }], 'x');
    expect(at('Přečtěte si naši webovou stránku.', stem)).toBe('naši webovou stránku');
  });

  it('jméno beze změny najde podle originálu, odkaz přes celý zdroj pokryje celý překlad', () => {
    const text = 'Více na blogu Adobe Life.';
    expect(at(text, findAnchors(text, [{ source: 'Adobe Life', target: 'Adobe život' }], 'x')[0])).toBe('Adobe Life');
    expect(at(text, findAnchors(text, [{ source: 'More on Adobe Life.' }], 'More on Adobe Life.')[0])).toBe('Více na blogu Adobe Life');
  });

  it('název najde v uvozovkách překladu na podobném místě', () => {
    // Originál uvozovky nemá, překladač je přidal.
    const source = 'See the webinar How Adobe Reengineered for Performance Agility. and the study Reengineering for Agility.';
    const text = 'Viz webinář „Jak Adobe transformovala své procesy pro agilitu.“ a studii „Transformace pro agilitu“.';
    const links = [
      { source: 'How Adobe Reengineered for Performance Agility.', target: 'Jak Adobe zásadně změnila fungování.' },
      { source: 'Reengineering for Agility', target: 'Zásadní změny pro agilitu' },
    ];
    expect(findAnchors(text, links, source).map((r) => at(text, r))).toEqual(['Jak Adobe transformovala své procesy pro agilitu', 'Transformace pro agilitu']);
  });

  it('stejný text dvakrát najde dvě místa, chybějící vrátí null', () => {
    const text = 'Klikněte zde nebo zde.';
    const [a, b, c] = findAnchors(text, [{ source: 'here', target: 'zde' }, { source: 'here', target: 'zde' }, { source: 'missing', target: 'chybí' }], 'x');
    expect([a!.start, b!.start]).toEqual([9, 18]);
    expect(c).toBeNull();
  });
});
