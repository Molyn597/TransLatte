import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { Segment } from '../shared/types';
import { finalText } from './segments';

const LIST_MARK = /^\s*([-*•–]|\d+[.)])\s+/;

function tableFrom(text: string) {
  const rows = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) =>
      l
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    );
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells, i) =>
        new TableRow({
          children: Array.from({ length: width }, (_, c) =>
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cells[c] ?? '', bold: i === 0 })] })] }),
          ),
        }),
    ),
  });
}

export async function buildDocx(title: string, segments: Segment[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const s of segments) {
    const text = finalText(s);
    if (s.kind === 'heading') {
      children.push(new Paragraph({ text, heading: children.length ? HeadingLevel.HEADING_2 : HeadingLevel.TITLE }));
    } else if (s.kind === 'list') {
      for (const line of text.split('\n').filter((l) => l.trim())) {
        children.push(new Paragraph({ text: line.replace(LIST_MARK, ''), bullet: { level: 0 } }));
      }
    } else if (s.kind === 'table') {
      const table = tableFrom(text);
      children.push(table ?? new Paragraph(text));
      children.push(new Paragraph(''));
    } else {
      children.push(new Paragraph({ children: [new TextRun(text)], spacing: { after: 160 } }));
    }
  }
  const doc = new Document({
    title,
    creator: 'TransLatte',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
