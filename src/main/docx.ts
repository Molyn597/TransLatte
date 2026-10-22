import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { Segment } from '../shared/types';
import { findAnchors } from './quality';
import { finalText, visibleSegments } from './segments';

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

type Span = { start: number; end: number; url: string };

/** Úsek textu [start, end) jako běžný text a odkazy (jen odkazy s URL). */
function inline(text: string, start: number, end: number, spans: Span[]) {
  const runs: (TextRun | ExternalHyperlink)[] = [];
  let at = start;
  for (const span of spans.filter((s) => s.start >= start && s.end <= end).sort((a, b) => a.start - b.start)) {
    if (span.start < at) continue;
    if (span.start > at) runs.push(new TextRun(text.slice(at, span.start)));
    runs.push(new ExternalHyperlink({ link: span.url, children: [new TextRun({ text: text.slice(span.start, span.end), style: 'Hyperlink' })] }));
    at = span.end;
  }
  if (at < end) runs.push(new TextRun(text.slice(at, end)));
  return runs;
}

function linkSpans(s: Segment, text: string): Span[] {
  if (!s.links) return [];
  const found = findAnchors(text, s.links, s.source);
  return s.links.flatMap((l, i) => (l.url && found[i] ? [{ ...found[i]!, url: l.url }] : []));
}

export async function buildDocx(title: string, segments: Segment[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const s of visibleSegments(segments)) {
    const text = finalText(s);
    const spans = linkSpans(s, text);
    if (s.kind === 'heading') {
      children.push(new Paragraph({ children: inline(text, 0, text.length, spans), heading: children.length ? HeadingLevel.HEADING_2 : HeadingLevel.TITLE }));
    } else if (s.kind === 'list') {
      let offset = 0;
      for (const line of text.split('\n')) {
        const start = offset + (line.match(LIST_MARK)?.[0].length ?? 0);
        if (line.trim()) children.push(new Paragraph({ children: inline(text, start, offset + line.length, spans), bullet: { level: 0 } }));
        offset += line.length + 1;
      }
    } else if (s.kind === 'table') {
      const table = tableFrom(text);
      children.push(table ?? new Paragraph(text));
      children.push(new Paragraph(''));
    } else {
      children.push(new Paragraph({ children: inline(text, 0, text.length, spans), spacing: { after: 160 } }));
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
