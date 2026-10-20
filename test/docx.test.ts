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
});
