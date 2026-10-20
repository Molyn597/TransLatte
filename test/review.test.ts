import { describe, expect, it } from 'vitest';
import type { DocumentContext, Segment } from '../src/shared/types';
import {
  acceptFix,
  applyDeterministic,
  changedWords,
  findIssues,
  issueCount,
  parseContext,
  reviewGlossary,
  wrongGender,
  type Issue,
  type ReviewOptions,
} from '../src/main/review';

const context = (over: Partial<DocumentContext> = {}): DocumentContext => ({
  topic: 'Řízení týmů',
  domain: 'management',
  author: 'Jana Nováková',
  authorGender: 'female',
  audience: 'manažeři',
  terms: [],
  ...over,
});

const options = (over: Partial<ReviewOptions> = {}): ReviewOptions => ({
  sourceLang: 'en',
  targetLang: 'cs',
  mode: 'balanced',
  glossary: [],
  ...over,
});

const para = (source: string) => ({ kind: 'paragraph' as const, source });
const kinds = (issues: Issue[]) => issues.map((i) => i.kind);

describe('wrongGender', () => {
  it('u autorky najde mužské příčestí s „jsem“ z obou stran i se zvratným zájmenem', () => {
    const text = 'Když jsem uvedl příklad, uvědomil jsem si chybu. Pak jsem si všiml dalšího.';
    expect(wrongGender(text, 'female')).toEqual(['jsem uvedl', 'uvědomil jsem', 'jsem si všiml']);
  });

  it('ženské tvary, množné číslo ani „nejsem“ u autorky nehlásí', () => {
    expect(wrongGender('Uvedla jsem příklad a jsem si jistá. Jsme uvedli. Nejsem rád.', 'female')).toEqual([]);
  });

  it('u autora obráceně najde ženské tvary', () => {
    expect(wrongGender('Jsem uvedla příklad, uvědomil jsem si to a Napsala jsem.', 'male')).toEqual(['Jsem uvedla', 'Napsala jsem']);
  });

  it('neznámý rod nekontroluje', () => {
    expect(wrongGender('jsem uvedl', 'unknown')).toEqual([]);
  });
});

describe('findIssues', () => {
  const source = 'We decided about promotions and shared the experience with our employees.';

  it('tabulky nekontroluje', () => {
    expect(findIssues({ kind: 'table', source: '| a |' }, '| the and |', ['chyba'], options())).toEqual([]);
  });

  it('pravopis jen pro češtinu', () => {
    const issues = findIssues(para('About promotions.'), 'Rozhodli jsme o povýšeních.', ['povýšeních'], options());
    expect(issues).toEqual([
      { kind: 'spelling', text: 'Pravděpodobné překlepy: povýšeních.', en: 'Probable typos: povýšeních.', count: 1 },
    ]);
    expect(findIssues(para('About promotions.'), 'Wir haben entschieden.', ['x'], options({ targetLang: 'de' }))).toEqual([]);
  });

  it('nepřeložená slova jen z angličtiny a od dvou slov', () => {
    const translation = 'Rozhodli jsme se o povýšení and sdíleli the zkušenost se zaměstnanci.';
    expect(kinds(findIssues(para(source), translation, [], options()))).toEqual(['untranslated']);
    expect(findIssues(para(source), 'Rozhodli jsme se o povýšení and sdíleli zkušenost se zaměstnanci.', [], options())).toEqual([]);
    expect(findIssues(para(source), translation, [], options({ sourceLang: 'de' }))).toEqual([]);
  });

  it('glosář: hlídá jen uživatelský glosář, termíny z kontextu se nevynucují', () => {
    const src = 'Fine-tuning improves the benchmark score of the model a lot.';
    const glossary = [{ source: 'fine-tuning', target: 'doladění' }];
    const ctx = context({ terms: [{ source: 'benchmark', target: 'srovnávací test' }] });
    const quality = options({ mode: 'quality', glossary, context: ctx });
    expect(findIssues(para(src), 'Doladění výrazně zlepšuje skóre modelu v testu.', [], quality)).toEqual([]);
    expect(findIssues(para(src), 'Ladění výrazně zlepšuje skóre modelu v testu.', [], quality).map((i) => i.text)).toEqual([
      'Chybí termín z glosáře: fine-tuning → doladění.',
    ]);
  });

  it('podezřelá délka a opakování', () => {
    expect(findIssues(para(source), 'Rozhodli jsme.', [], options())[0].text).toContain('podezřele krátký');
    const repeated = Array(5).fill('jedna dva tři čtyři pět šest').join(' ');
    expect(kinds(findIssues(para(repeated), repeated, [], options({ sourceLang: 'cs' })))).toEqual(['suspicious']);
  });

  it('rod autora jen v Kvalitním s kontextem a pro češtinu', () => {
    const src = 'When I mentioned the example, I realised that the mistake was mine.';
    const translation = 'Když jsem uvedl příklad, uvědomil jsem si, že chyba byla moje.';
    const issues = findIssues(para(src), translation, [], options({ mode: 'quality', context: context() }));
    expect(issues).toEqual([
      {
        kind: 'gender',
        text: 'Autor je žena, ale překlad používá mužský rod: „jsem uvedl“, „uvědomil jsem“.',
        en: '',
        count: 2,
      },
    ]);
    expect(findIssues(para(src), translation, [], options({ context: context() }))).toEqual([]);
    expect(findIssues(para(src), translation, [], options({ mode: 'quality' }))).toEqual([]);
  });
});

describe('reviewGlossary', () => {
  it('vrací jen uživatelský glosář, ani v Kvalitním nepřidá termíny z kontextu', () => {
    const glossary = [{ source: 'LLM', target: 'velký jazykový model' }];
    const ctx = context({ terms: [{ source: 'prompt', target: 'zadání' }] });
    expect(reviewGlossary({ glossary })).toBe(glossary);
    expect(reviewGlossary(options({ mode: 'quality', glossary, context: ctx }))).toBe(glossary);
  });
});

describe('changedWords', () => {
  it('náhradu počítá jednou, vložená i smazaná slova zvlášť, interpunkci a velikost písmen ignoruje', () => {
    expect(changedWords('Jsem uvedl příklad.', 'Jsem uvedla příklad.')).toBe(1);
    expect(changedWords('a b c d', 'a x c d e')).toBe(2);
    expect(changedWords('a b c d', 'a d')).toBe(2);
    expect(changedWords('Ahoj, světe.', 'ahoj světe')).toBe(0);
    expect(changedWords('', 'jedna dva')).toBe(2);
  });
});

describe('acceptFix', () => {
  const source = 'We decided about promotions and shared our experience with the employees.';
  const before = 'Rozhodli jsme o povýbeních a sdíleli jsme svou zkušenost se zaměstnanci firmy.';
  const spelling = (n: number): Issue[] => (n ? [{ kind: 'spelling', text: '', en: '', count: n }] : []);

  it('přijme cílenou opravu, která problémy ubrala', () => {
    const after = 'Rozhodli jsme o povýšeních a sdíleli jsme svou zkušenost se zaměstnanci firmy.';
    expect(acceptFix(source, before, after, spelling(1), [])).toBe(true);
  });

  it('pár slov změněných kvůli rodu projde i v dlouhém odstavci', () => {
    const long = 'Když jsem uvedl tento příklad na poradě vedení, uvědomil jsem si, že většina manažerů o systému Check-in nikdy neslyšela a že je potřeba vysvětlit, jak funguje.';
    const fixed = 'Když jsem uvedla tento příklad na poradě vedení, uvědomila jsem si, že většina manažerů o systému Check-in nikdy neslyšela a že je potřeba vysvětlit, jak funguje.';
    const gender: Issue[] = [{ kind: 'gender', text: '', en: '', count: 2 }];
    expect(acceptFix(source, long, fixed, gender, [])).toBe(true);
  });

  it('odmítne prázdný výsledek a přepsání 10 slov kvůli jednomu překlepu', () => {
    expect(acceptFix(source, before, '  ', spelling(1), [])).toBe(false);
    const rewritten = 'Rozhodli jsme o povýšeních, podělili jsme se o naše poznatky se všemi lidmi v celé organizaci.';
    expect(changedWords(before, rewritten)).toBeGreaterThanOrEqual(10);
    expect(acceptFix(source, before, rewritten, spelling(1), [])).toBe(false);
  });

  it('odmítne vysvětlivky v závorkách přidané k několika výskytům termínu', () => {
    const text = 'Systém Check-in nahradil hodnocení. Každý Check-in trvá hodinu a po Check-in následuje plán.';
    const glossed = text.replace(/Check-in/g, 'Check-in (běžné zpětné vazby)');
    const glossary: Issue[] = [{ kind: 'glossary', text: '', en: '', count: 1 }];
    expect(acceptFix(source, text, glossed, glossary, [])).toBe(false);
  });

  it('odmítne opravu, po které je problémů víc', () => {
    const after = 'Rozhodli jsme o povýšeních a sdílili jsme svou zkušenost se zaměstnanci frmy.';
    expect(acceptFix(source, before, after, spelling(1), spelling(2))).toBe(false);
    expect(issueCount([...spelling(2), { kind: 'glossary', text: '', en: '', count: 1 }])).toBe(3);
  });

  it('u podezřelé délky stačí poměr vůči originálu 0,6–1,8', () => {
    const suspicious: Issue[] = [{ kind: 'suspicious', text: '', en: '', count: 1 }];
    const full = 'Rozhodli jsme se o povýšeních a podělili se o své zkušenosti se zaměstnanci.';
    expect(acceptFix(source, 'Rozhodli jsme.', full, suspicious, [])).toBe(true);
    expect(acceptFix(source, 'Rozhodli jsme.', 'Rozhodli jsme se.', suspicious, [])).toBe(false);
    expect(acceptFix(source, 'Rozhodli jsme.', full.repeat(2), suspicious, [])).toBe(false);
  });
});

describe('parseContext', () => {
  const json = '{"topic": "Řízení", "domain": "HR", "author": "Jana", "authorGender": "female", "audience": "manažeři", "terms": [{"source": "onboarding", "target": "zaškolení"}]}';

  it('přečte JSON v ohradách ```json', () => {
    expect(parseContext('```json\n' + json + '\n```')).toEqual({
      topic: 'Řízení',
      domain: 'HR',
      author: 'Jana',
      authorGender: 'female',
      audience: 'manažeři',
      terms: [{ source: 'onboarding', target: 'zaškolení' }],
    });
  });

  it('vezme první blok z textu okolo, i se složenými závorkami v řetězcích', () => {
    const out = `Tady je kontext: {"topic": "Kód {a} \\"b\\"", "authorGender": "MALE", "terms": [{"source": "x"}, 5, null]} A ještě {"topic": "druhý"}`;
    expect(parseContext(out)).toEqual({
      topic: 'Kód {a} "b"',
      domain: '',
      author: '',
      authorGender: 'male',
      audience: '',
      terms: [],
    });
  });

  it('nevalidní výstup vrátí undefined bez pádu', () => {
    expect(parseContext('Nevím.')).toBeUndefined();
    expect(parseContext('{"topic": "useknuto')).toBeUndefined();
    expect(parseContext('{topic: neplatné}')).toBeUndefined();
    expect(parseContext('[{"topic": "pole"}]')?.topic).toBe('pole');
  });

  it('neznámý rod převede na unknown', () => {
    expect(parseContext('{"authorGender": "both"}')?.authorGender).toBe('unknown');
  });
});

describe('applyDeterministic', () => {
  const segments = (): Segment[] => [
    { id: 0, kind: 'paragraph', source: 'a', translation: 'Mluvil s zaměstnanci 6. květen 2019.', polished: 'k kolegům v Vídni' },
    { id: 1, kind: 'heading', source: 'b' },
  ];

  it('u češtiny opraví předložky a měsíce v překladu i opravě', () => {
    const s = segments();
    applyDeterministic(s, 'cs');
    expect(s[0].translation).toBe('Mluvil se zaměstnanci 6. května 2019.');
    expect(s[0].polished).toBe('ke kolegům ve Vídni');
    expect(s[1].translation).toBeUndefined();
  });

  it('u jiných jazyků nic nemění', () => {
    const s = segments();
    applyDeterministic(s, 'de');
    expect(s).toEqual(segments());
  });
});
