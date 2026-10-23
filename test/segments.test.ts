import { describe, expect, it } from 'vitest';
import type { TextItem } from '../src/shared/pdf';
import {
  attachLinks,
  linkAnchors,
  blocksToSegments,
  groupSegments,
  layoutToBlocks,
  markdownToBlocks,
  markDuplicateBlocks,
  dropRepeatedBlocks,
  addUnreadableTables,
  mergeAcrossPages,
  mergeBrokenHeadings,
  normalizeMarkdownTable,
  parseOcr,
  removePageFurniture,
  segmentsToMarkdown,
  sentenceChunks,
  splitBatch,
  stripAddedPeriod,
  textLayerGeometry,
  type Block,
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

  it('citát, který opakuje větu z článku, ponechá jen pro přeložené PDF; odstavec zůstane viditelný', () => {
    const blocks = markDuplicateBlocks([
      { kind: 'heading', text: quote },
      { kind: 'paragraph', text: `We found that ${quote.toLowerCase()} -- and managers agree.` },
      { kind: 'heading', text: 'Results' },
      { kind: 'paragraph', text: 'Results were clear.' },
    ]);
    expect(blocks.map((b) => `${b.layoutOnly ? 'pdf' : 'vidět'}:${b.text.slice(0, 13)}`)).toEqual([
      'pdf:Good teams ne',
      'vidět:We found that',
      'vidět:Results',
      'vidět:Results were ',
    ]);
  });

  it('citát jen pro PDF se neexportuje do Markdownu', () => {
    const segments = blocksToSegments([
      { kind: 'heading', text: quote, layoutOnly: true },
      { kind: 'paragraph', text: 'Body' },
    ]);
    expect(segments[0].layoutOnly).toBe(true);
    segments[0].translation = 'Citát';
    segments[1].translation = 'Text';
    expect(segmentsToMarkdown(segments)).toBe('Text');
  });
});

describe('geometrie bloků pro přeložené PDF', () => {
  it('blok z textové vrstvy nese obálku řádků, písmo a typ', () => {
    const items: TextItem[] = [
      { ...item('Results', 50, 80, 60, 16), bold: true },
      { ...item('First body line that is long', 52, 100, 300), serif: true },
      { ...item('second line.', 50, 112, 80), serif: true },
    ];
    const [heading, body] = layoutToBlocks(items, 600, 3);
    expect(heading).toMatchObject({ kind: 'heading', bold: true, fontSize: 16, rects: [{ page: 3, x: 50, y: 80, w: 60, h: 19.2 }] });
    // Spodní okraj = horní okraj posledního řádku + 1,2 × výška (dotažnice).
    expect(body).toMatchObject({ serif: true, bold: false, fontSize: 10, rects: [{ page: 3, x: 50, y: 100, w: 302, h: 24 }] });
    expect(body.rects![0].chars).toBe(body.text.length);
  });

  it('řádek tabulky má plochy k překrytí po sloupcích, název na střed se pozná', () => {
    const blocks = layoutToBlocks(
      [
        item('Centered title', 250, 40, 100, 16),
        item('Group', 50, 100, 40),
        item('Score', 200, 100, 40),
        item('Short', 50, 112, 40),
        item('84', 200, 112, 10),
      ],
      600,
      1,
    );
    expect(blocks[0]).toMatchObject({ kind: 'heading', centered: true });
    expect(blocks[1].centered).toBeUndefined();
    expect(blocks[1].rects![0].cover).toEqual([
      [50, 100, 40, 12],
      [200, 100, 40, 12],
      [50, 112, 40, 12],
      [200, 112, 10, 12],
    ]);
  });

  it('box z OCR přepočítá na body stránky u všech bloků', () => {
    const blocks = parseOcr('title [0, 0, 999, 99]Heading\ntext [99, 199, 599, 399]Some paragraph text here.', 1, { width: 600, height: 800 });
    expect(blocks[0].rects).toEqual([{ page: 1, x: 0, y: 0, w: 600, h: 79.3, chars: 7 }]);
    expect(blocks[1].rects![0]).toMatchObject({ x: 59.5, y: 159.4, w: 300.3, h: 160.2 });
    expect(blocks[1].fontSize).toBeGreaterThan(5);
    expect(blocks[0].bold).toBe(true);
  });

  it('blok z OCR na digitální stránce převezme písmo a řádky z textové vrstvy', () => {
    const [table] = parseOcr('table [83, 124, 499, 249]<table><tr><td>Group</td><td>Score</td></tr></table>', 1, { width: 600, height: 800 });
    expect(table.fontSize).toBeGreaterThan(9);
    textLayerGeometry(
      [table],
      [{ ...item('Group', 55, 104, 40, 9), serif: true }, { ...item('Score', 200, 104, 40, 9), serif: true }, item('Elsewhere', 400, 600)],
      600,
    );
    expect(table).toMatchObject({ fontSize: 9, serif: true, rects: [{ x: 55, y: 104, w: 185, cover: [[55, 104, 40, 10.8], [200, 104, 40, 10.8]] }] });
  });

  it('odstavec přes konec stránky má obdélníky na obou stránkách', () => {
    const rect = (page: number) => ({ page, x: 50, y: 700, w: 300, h: 40, chars: 90 });
    const [merged] = mergeAcrossPages([
      { kind: 'paragraph', text: 'As this journey continues, we keep focusing on our key learnings to continue to enrich the', page: 1, rects: [rect(1)] },
      { kind: 'paragraph', text: 'Check-in approach.', page: 2, rects: [rect(2)] },
    ]);
    expect(merged.rects!.map((r) => r.page)).toEqual([1, 2]);
    const [heading] = mergeBrokenHeadings([
      { kind: 'heading', text: 'Good teams need honest', page: 2, rects: [rect(2)] },
      { kind: 'heading', text: 'conversations', page: 2, rects: [rect(2)] },
    ]);
    expect(heading.rects).toHaveLength(2);
    expect(blocksToSegments([merged])[0].rects).toHaveLength(2);
  });
});

describe('odkazy z anotací', () => {
  const item = (str: string, x: number, y: number, w: number): TextItem => ({ str, x, y, w, h: 10 });

  it('vezme slova v ploše odkazu a spojí odkaz zalomený přes řádek', () => {
    // 10 bodů na znak.
    const items = [item('Read the great report', 0, 0, 210), item('by Bersin today.', 0, 12, 160)];
    const links = [
      { url: 'http://b.com', x: 0, y: 12, w: 90, h: 11 },
      { url: 'http://b.com', x: 140, y: -1, w: 70, h: 11 },
      { url: 'http://site.com', x: 0, y: -10, w: 300, h: 40 },
    ];
    const [link, ...rest] = linkAnchors(items, links, 3);
    expect(rest).toEqual([]);
    expect(link.source).toBe('report by Bersin');
    expect(link.url).toBe('http://b.com');
    expect(link.rects.map((r) => [r.page, r.y])).toEqual([[3, -1], [3, 12]]);
  });

  it('odkaz přiřadí bloku, ve kterém leží', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', text: 'A', rects: [{ page: 1, x: 0, y: 0, w: 100, h: 20 }] },
      { kind: 'paragraph', text: 'B', rects: [{ page: 1, x: 0, y: 50, w: 100, h: 20, cover: [[0, 50, 100, 12]] as [number, number, number, number][] }] },
    ];
    const link = { source: 'B', rects: [{ page: 1, x: 10, y: 50, w: 20, h: 10 }] };
    attachLinks(blocks, [link]);
    expect(blocks[1].links).toEqual([link]);
    expect(blocks[0].links).toBeUndefined();
  });
});

describe('časopis ve dvou sloupcích (podle R&D Management 2019)', () => {
  // Stránka 595 bodů: sloupce 71–282 a 300–511, mezi nimi 18 bodů.
  const line = (text: string, x: number, y: number) => item(text, x, y, 211);
  const column = (prefix: string, x: number, top: number, n: number) => Array.from({ length: n }, (_, i) => line(`${prefix} ${i}`, x, top + i * 12));

  it('střídavé živé záhlaví (autoři na sudých, název na lichých stránkách) zahodí', () => {
    const authors = 'Tomoatsu Shibata, Yasunori Baba, Mitsuru Kodama and Jun Suzuki';
    const title = 'Managing ambidextrous organizations for corporate transformation';
    const pages = Array.from({ length: 6 }, (_, n) => ({
      height: 842,
      items: [item(n % 2 ? authors : title, 84, 82, 280), item(`Body text of page ${n + 1}`, 84, 300)],
    }));
    expect(removePageFurniture(pages).map((items) => items.map((i) => i.str))).toEqual(pages.map((_, n) => [`Body text of page ${n + 1}`]));
  });

  it('abstrakt přes celou šířku nad sloupci a sloupce pod ním se neprolínají', () => {
    const items = [
      item('The concept of ambidextrous organizations, allowing exploration and exploitation', 98, 480, 386),
      item('activities to coexist within an organization, has attracted considerable interest.', 98, 493, 386),
      ...column('Left', 71, 600, 5),
      ...column('Right', 300, 600, 5),
    ];
    expect(layoutToBlocks(items, 595, 1).map((b) => b.text.slice(0, 7))).toEqual(['The con', 'Left 0 ', 'Right 0']);
  });

  it('poslední slovo řádku těsně u středu stránky patří do levého sloupce', () => {
    const items = [...column('Left', 84, 100, 5).map((i) => ({ ...i, w: 198 })), item('is', 288.7, 136, 6.7), ...column('Right', 313, 100, 5)];
    const [left, right] = layoutToBlocks(items, 595, 2);
    expect(left.text).toBe('Left 0 Left 1 Left 2 Left 3 is Left 4');
    expect(right.rects![0].x).toBe(313);
  });

  it('iniciálu spojí s prvním slovem a odstavec nebere jako nadpis', () => {
    const items = [
      { ...item('M', 71, 639, 29, 30) },
      item('ost companies involved in photographic', 100, 647, 182),
      item('film either withdrew from the market or', 100, 660, 182),
      line('went bankrupt following the emergence.', 71, 672),
    ];
    const [block] = layoutToBlocks(items, 595, 1);
    expect(block).toMatchObject({ kind: 'paragraph', text: 'Most companies involved in photographic film either withdrew from the market or went bankrupt following the emergence.' });
  });

  it('odstavec přetékající do dalšího sloupce je jeden blok s plochou v obou sloupcích', () => {
    const items = [
      line('Most companies involved in photographic film either withdrew', 71, 100),
      line('from the market or went bankrupt following the emergence of', 71, 112),
      line('digitalization. How Fujifilm managed its transformation is', 71, 124),
      line('therefore of great interest. This paper examines the process', 300, 100),
      line('from the perspective of an ambidextrous organization.', 300, 112),
      line('Another paragraph in the right column ends with a period.', 300, 140),
    ];
    const blocks = layoutToBlocks(items, 595, 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('transformation is therefore of great interest');
    expect(blocks[0].rects!.map((r) => r.x)).toEqual([71, 300]);
  });

  it('rok na začátku řádku uprostřed věty není číslovaný seznam', () => {
    const items = [
      line('applications filed jointly with other organizations between 1982 and', 300, 100),
      line('2012. Beginning around 2003, the number of joint applications', 300, 112),
    ];
    expect(layoutToBlocks(items, 595, 4).map((b) => b.kind)).toEqual(['paragraph']);
  });

  it('přes konec stránky přeskočí popisek tabulky i štítky grafu nahoře na další stránce', () => {
    const body = (text: string, page: number): Block => ({ kind: 'paragraph', text, page, fontSize: 10 });
    const merged = mergeAcrossPages([
      body('Beginning around 2003, the number of joint applications increased. Both figures indicate that, beginning around 2002–2003,', 4),
      { kind: 'paragraph', text: 'Table 1. Cumulative numbers of Fujifilm’s patent applications', page: 4, fontSize: 9 },
      { kind: 'heading', text: 'FUJIFILM 6-13', page: 5, fontSize: 13.5 },
      { kind: 'paragraph', text: 'Figure 1. Trends in patent applications of peripheral technical areas.', page: 5, fontSize: 8 },
      body('Fujifilm aggressively and systematically accelerated exploration for diversification.', 5),
    ]);
    expect(merged.map((b) => b.text.slice(0, 12))).toEqual(['Beginning ar', 'Table 1. Cum', 'FUJIFILM 6-1', 'Figure 1. Tr']);
    expect(merged[0].text).toMatch(/2002–2003, Fujifilm aggressively/);
  });

  it('stejnou lištu webu na další stránce nespojí', () => {
    const banner = 'Gallup uses cookies to ensure the best website experience. Please select the cookies you want. Privacy Statement';
    expect(mergeAcrossPages([{ kind: 'paragraph', text: banner, page: 9 }, { kind: 'paragraph', text: banner, page: 10 }])).toHaveLength(2);
  });

  it('pod popiskem tabulky bez textu (křivky) přidá tabulku k přečtení z výřezu', () => {
    const size = { width: 595, height: 842 };
    const items = [item('Table 1. Cumulative numbers of patent applications', 84, 558, 397, 9), item('Body text', 84, 300, 211)];
    const blocks = layoutToBlocks(items, 595, 4);
    const out = addUnreadableTables(blocks, items, size);
    expect(out.at(-1)).toMatchObject({ kind: 'table', text: '', page: 4, needsRepair: true });
    const [x0, y0, x1, y1] = out.at(-1)!.box!;
    expect([x0, x1]).toEqual([Math.round((84 / 595) * 999), Math.round((481 / 595) * 999)]);
    expect(y0).toBeGreaterThan(Math.round((558 / 842) * 999));
    expect(y1).toBe(Math.round(0.92 * 999));
    // Tabulka s textovou vrstvou hned pod popiskem se nepřidá.
    const withText = [...items, ...[584, 596, 608].map((y) => item('Optics 109326 1 30.4%', 84, y, 300))];
    expect(addUnreadableTables(layoutToBlocks(withText, 595, 4), withText, size).some((b) => b.kind === 'table')).toBe(false);
  });
});
