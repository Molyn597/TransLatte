import { describe, expect, it } from 'vitest';
import type { TextItem } from '../src/shared/pdf';
import {
  blocksToSegments,
  groupSegments,
  layoutToBlocks,
  markdownToBlocks,
  dropDuplicateBlocks,
  dropRepeatedBlocks,
  mergeAcrossPages,
  mergeBrokenHeadings,
  normalizeMarkdownTable,
  parseOcr,
  removePageFurniture,
  segmentsToMarkdown,
  sentenceChunks,
  splitBatch,
  stripAddedPeriod,
} from '../src/main/segments';

describe('parseOcr', () => {
  // Skutečný výstup Unlimited-OCR z testu na skenu.
  const output = [
    'title [18, 21, 495, 43]Urban Green Spaces and Mental Well-being',
    'text [19, 54, 115, 73]Abstract',
    'text [17, 80, 968, 150]Access to parks has been linked to lower stress. We report \\(18\\%\\) lower scores.',
    'title [20, 160, 202, 179]1. Introduction',
    'page_number [500, 990, 520, 1000]3',
    'text [17, 187, 972, 271]Rapid urbanization has reduced natural space.',
  ].join('\n');

  it('rozliší nadpisy a odstavce, zahodí číslo stránky', () => {
    const blocks = parseOcr(output, 2);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'paragraph', 'heading', 'paragraph']);
    expect(blocks.every((b) => b.page === 2)).toBe(true);
    expect(blocks.some((b) => b.text === '3')).toBe(false);
  });

  it('odstraní LaTeX zápis procent', () => {
    expect(parseOcr(output, 1)[2].text).toContain('18% lower');
  });

  it('převede HTML tabulku na Markdown', () => {
    const blocks = parseOcr('table [1, 2, 3, 4]<table><tr><td>Group</td><td>Score</td></tr><tr><td>A</td><td>12</td></tr></table>', 1);
    expect(blocks[0].kind).toBe('table');
    expect(blocks[0].text).toBe('| Group | Score |\n| --- | --- |\n| A | 12 |');
  });

  it('tabulku bez buněk (LM Studio zahodí <tr>/<td>) označí k opravě i s umístěním', () => {
    const raw =
      'table [515, 152, 918, 278]<table>GroupAverage sleepParticipantsAccuracyShort sleepersunder 6 h8471 %</table>';
    const [block] = parseOcr(raw, 1);
    expect(block).toMatchObject({ kind: 'table', needsRepair: true, box: [515, 152, 918, 278] });
    expect(block.text).toBe('Group Average sleep Participants Accuracy Short sleepersunder 6 h 8471 %');
  });

  it('výstup bez štítků zpracuje jako Markdown', () => {
    const blocks = parseOcr('# Title\n\nFirst paragraph\ncontinues here.\n\n- one\n- two', 1);
    expect(blocks).toEqual([
      { kind: 'heading', text: 'Title', page: 1 },
      { kind: 'paragraph', text: 'First paragraph continues here.', page: 1 },
      { kind: 'list', text: '- one\n- two', page: 1 },
    ]);
  });
});

describe('markdownToBlocks', () => {
  it('pozná tabulku a přeskočí komentáře', () => {
    const blocks = markdownToBlocks('<!-- image -->\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('table');
  });
});

const item = (str: string, x: number, y: number, w = str.length * 5, h = 10): TextItem => ({ str, x, y, w, h });

describe('layoutToBlocks', () => {
  it('spojí řádky do odstavce a slova rozdělená spojovníkem', () => {
    const blocks = layoutToBlocks(
      [item('This is a long para-', 50, 100), item('graph that continues.', 50, 112), item('New paragraph.', 50, 150)],
      600,
      1,
    );
    expect(blocks.map((b) => b.text)).toEqual(['This is a long paragraph that continues.', 'New paragraph.']);
  });

  it('větší písmo je nadpis', () => {
    const blocks = layoutToBlocks([item('Results', 50, 80, 60, 16), item('Body text here.', 50, 100), item('More body.', 50, 112)], 600, 1);
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'Results' });
  });

  it('název nad sloupci je nadpis a dvouřádkový nadpis zůstane celý', () => {
    const items: TextItem[] = [
      item('Sleep Duration and Working Memory', 60, 50, 470, 18),
      item('Students', 250, 72, 80, 18),
      item('A. Example — Department', 170, 96, 250),
    ];
    for (let i = 0; i < 6; i++) {
      items.push(item(`Left ${i}`, 40, 140 + i * 14, 200));
      items.push(item(`Right ${i}`, 330, 140 + i * 14, 200));
    }
    items.push(item('1. Introduction', 40, 230, 90, 12));
    const blocks = layoutToBlocks(items, 600, 1);
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'Sleep Duration and Working Memory Students' });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', text: 'A. Example — Department' });
    expect(blocks.find((b) => b.text === '1. Introduction')?.kind).toBe('heading');
  });

  it('dvousloupcovou stránku čte po sloupcích', () => {
    const items: TextItem[] = [item('Title spanning both columns', 100, 40, 400, 16)];
    for (let i = 0; i < 6; i++) {
      items.push(item(`Left ${i}`, 40, 100 + i * 12, 200));
      items.push(item(`Right ${i}`, 330, 100 + i * 12, 200));
    }
    const text = layoutToBlocks(items, 600, 1)
      .map((b) => b.text)
      .join(' | ');
    expect(text).toBe('Title spanning both columns | Left 0 Left 1 Left 2 Left 3 Left 4 Left 5 | Right 0 Right 1 Right 2 Right 3 Right 4 Right 5');
  });
});

describe('dávky pro překlad', () => {
  const segments = blocksToSegments([
    { kind: 'heading', text: 'A'.repeat(10) },
    { kind: 'paragraph', text: 'B'.repeat(900) },
    { kind: 'paragraph', text: 'C'.repeat(900) },
    { kind: 'table', text: '| x |' },
    { kind: 'paragraph', text: 'D'.repeat(10) },
  ]);

  it('drží dávky pod limitem a tabulky zvlášť', () => {
    expect(groupSegments(segments, 1500)).toEqual([[0, 1], [2], [3], [4]]);
  });

  it('rozdělí odpověď jen při stejném počtu odstavců', () => {
    expect(splitBatch('jedna\n\ndva\n\n\ntři', 3)).toEqual(['jedna', 'dva', 'tři']);
    expect(splitBatch('jedna dva', 2)).toBeNull();
    // Jediný odstavec, který model rozdělil na dva, se nepřekládá znovu.
    expect(splitBatch('první půlka\n\ndruhá půlka', 1)).toEqual(['první půlka druhá půlka']);
  });

  it('Markdown výstup používá úpravy uživatele před ostatními verzemi', () => {
    const s = blocksToSegments([{ kind: 'heading', text: 'Intro' }, { kind: 'paragraph', text: 'Hello' }]);
    s[0].translation = 'Úvod';
    s[1].translation = 'Ahoj';
    s[1].polished = 'Dobrý den';
    s[1].edited = 'Zdravím';
    expect(segmentsToMarkdown(s)).toBe('## Úvod\n\nZdravím');
  });
});

describe('normalizeMarkdownTable', () => {
  it('spojí řádek zalomený vision modelem (skutečný výstup Gemma 4)', () => {
    const out = '| Group | Average sleep |\n| --- | --- |\n| Short sleepers | \n84 |\n| Long sleepers | 97 |';
    expect(normalizeMarkdownTable(out)).toBe('| Group | Average sleep |\n| --- | --- |\n| Short sleepers | 84 |\n| Long sleepers | 97 |');
  });

  it('odmítne odpověď, která není tabulka', () => {
    expect(normalizeMarkdownTable('Sorry, I cannot read this.')).toBeNull();
  });
});

describe('záhlaví, zápatí a konce stránek', () => {
  // Podle skutečného PDF: lišta webu „Sign In“ na každé stránce na stejném místě.
  const page = (n: number, text: string) => ({
    height: 792,
    items: [item('Sign In', 535, 52, 40), item(text, 50, 300, 400), item(String(n), 300, 770, 6)],
  });

  it('odstraní opakovanou lištu a čísla stránek, text nechá', () => {
    const out = removePageFurniture([page(1, 'First page text'), page(2, 'Second page text'), page(3, 'Third')]);
    expect(out.map((items) => items.map((i) => i.str))).toEqual([['First page text'], ['Second page text'], ['Third']]);
  });

  it('jednostránkový dokument nechá beze změny (kromě čísla stránky)', () => {
    expect(removePageFurniture([page(1, 'Only page')])[0].map((i) => i.str)).toEqual(['Sign In', 'Only page']);
  });

  it('zahodí stejné krátké bloky z OCR na většině stránek', () => {
    const blocks = [1, 2, 3].flatMap((p) => [
      { kind: 'paragraph' as const, text: 'Journal of Examples 12', page: p },
      { kind: 'paragraph' as const, text: `Body ${p}`, page: p },
    ]);
    expect(dropRepeatedBlocks(blocks).map((b) => b.text)).toEqual(['Body 1', 'Body 2', 'Body 3']);
  });

  it('spojí odstavec rozdělený koncem stránky, ukončený odstavec ne', () => {
    const merged = mergeAcrossPages([
      { kind: 'paragraph', text: 'As this journey continues, we keep focusing on our key learnings to continue to enrich the', page: 1 },
      { kind: 'paragraph', text: 'Check-in approach and use it as a foundation.', page: 2 },
      { kind: 'paragraph', text: 'Next paragraph ends here.', page: 2 },
      { kind: 'paragraph', text: 'Fresh start on page three', page: 3 },
      { kind: 'paragraph', text: 'Footer on page four.', page: 4 },
    ]);
    expect(merged.map((b) => b.text)).toEqual([
      'As this journey continues, we keep focusing on our key learnings to continue to enrich the Check-in approach and use it as a foundation.',
      'Next paragraph ends here.',
      'Fresh start on page three',
      'Footer on page four.',
    ]);
  });

  it('samotné symboly se nepřekládají', () => {
    expect(blocksToSegments([{ kind: 'heading', text: '☰' }, { kind: 'paragraph', text: 'Text' }]).map((s) => s.source)).toEqual(['Text']);
  });
});

describe('stripAddedPeriod', () => {
  it('odebere tečku, kterou originál nemá', () => {
    expect(stripAddedPeriod('1. On-Going Awareness', '1. Neustálé informování.')).toBe('1. Neustálé informování');
    expect(stripAddedPeriod('Sign In', 'Přihlásit se.')).toBe('Přihlásit se');
  });

  it('tečku originálu a tři tečky nechá', () => {
    expect(stripAddedPeriod('It works.', 'Funguje to.')).toBe('Funguje to.');
    expect(stripAddedPeriod('and', 'a...')).toBe('a...');
  });
});

describe('sentenceChunks', () => {
  it('dělí dlouhý odstavec po větách, větu nikdy nepůlí', () => {
    const text = 'First sentence is here. Second one follows! Third? 4th starts with a digit. "Quoted" ends it.';
    const chunks = sentenceChunks(text, 50);
    expect(chunks.join(' ')).toBe(text);
    expect(chunks.every((c) => c.length <= 50 || !c.includes('. '))).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('zkratky uprostřed věty (e.g. 3.5) nerozdělí', () => {
    expect(sentenceChunks('Values rose by 3.5 percent in total.', 10)).toEqual(['Values rose by 3.5 percent in total.']);
  });
});

describe('zvýrazněné citáty', () => {
  const quote = 'Good teams need honest conversations every single week';

  it('pokračování nadpisu malým písmenem se spojí i při větším řádkování', () => {
    const blocks = layoutToBlocks(
      [
        item('Good teams need honest', 50, 100, 300, 20),
        item('conversations every single week', 50, 150, 300, 20),
        ...[0, 1, 2, 3].map((i) => item(`Body line ${i}`, 50, 200 + i * 12)),
      ],
      600,
      1,
    );
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'Good teams need honest conversations every single week' });
  });

  it('rozdělený nadpis z OCR spojí jen na stejné stránce', () => {
    const merged = mergeBrokenHeadings([
      { kind: 'heading', text: 'Good teams need honest', page: 2 },
      { kind: 'heading', text: 'conversations every single week', page: 2 },
      { kind: 'heading', text: 'Results', page: 2 },
    ]);
    expect(merged.map((b) => b.text)).toEqual([quote, 'Results']);
  });

  it('citát, který opakuje větu z článku, zahodí; odstavec nechá', () => {
    const blocks = dropDuplicateBlocks([
      { kind: 'heading', text: quote },
      { kind: 'paragraph', text: `We found that ${quote.toLowerCase()} -- and managers agree.` },
      { kind: 'heading', text: 'Results' },
      { kind: 'paragraph', text: 'Results were clear.' },
    ]);
    expect(blocks.map((b) => b.kind + ':' + b.text.slice(0, 13))).toEqual(['paragraph:We found that', 'heading:Results', 'paragraph:Results were ']);
  });
});
