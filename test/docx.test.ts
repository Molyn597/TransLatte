import { describe, expect, it } from 'vitest';
import { buildDocx } from '../src/main/docx';
import type { Segment } from '../src/shared/types';

describe('buildDocx', () => {
  it('vytvoří platný .docx s nadpisy, seznamem i tabulkou', async () => {
    const segments: Segment[] = [
      { id: 0, kind: 'heading', source: 'Title', translation: 'Název' },
      { id: 1, kind: 'paragraph', source: 'Text', translation: 'Překlad s diakritikou: žluťoučký kůň' },
      { id: 2, kind: 'list', source: '- a\n- b', translation: '- jedna\n- dvě' },
      { id: 3, kind: 'table', source: '| a | b |', translation: '| Skupina | Skóre |\n| --- | --- |\n| A | 12 |' },
    ];
    const buffer = await buildDocx('Test', segments);
    // .docx je ZIP: hlavička PK a dokument uvnitř.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.includes(Buffer.from('word/document.xml'))).toBe(true);
    expect(buffer.length).toBeGreaterThan(3000);
  });

  it('citát jen pro přeložené PDF do .docx nedá', async () => {
    const segments: Segment[] = [
      { id: 0, kind: 'heading', source: 'Quote', translation: 'ZvyraznenyCitat', layoutOnly: true },
      { id: 1, kind: 'paragraph', source: 'Text', translation: 'ObycejnyText' },
    ];
    const zip = await buildDocx('Test', segments);
    const { default: JSZip } = await import('jszip');
    const xml = await (await JSZip.loadAsync(zip)).file('word/document.xml')!.async('string');
    expect(xml).toContain('ObycejnyText');
    expect(xml).not.toContain('ZvyraznenyCitat');
  });

  it('odkaz převede na hypertextový odkaz', async () => {
    const segments: Segment[] = [
      {
        id: 0,
        kind: 'paragraph',
        source: 'Read the report by Bersin today.',
        translation: 'Přečtěte si dnes zprávu od Bersin.',
        links: [{ url: 'http://www.bersin.com/', source: 'report by Bersin', target: 'zprávu od Bersin', rects: [] }],
      },
      { id: 1, kind: 'list', source: '- see docs', translation: '- viz dokumentace', links: [{ url: 'https://example.com/docs', source: 'docs', target: 'dokumentace', rects: [] }] },
    ];
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await buildDocx('Test', segments));
    const xml = await zip.file('word/document.xml')!.async('string');
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(xml).toMatch(/<w:hyperlink[^>]*>.*zprávu od Bersin.*<\/w:hyperlink>/);
    expect(xml).toContain('Přečtěte si dnes ');
    expect(xml).toMatch(/<w:hyperlink[^>]*>.*dokumentace.*<\/w:hyperlink>/);
    expect(rels).toContain('http://www.bersin.com/');
    expect(rels).toContain('https://example.com/docs');
  });
});
