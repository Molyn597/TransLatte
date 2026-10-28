import { Document, ExternalHyperlink, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Šířka textu na A4 s okraji 1 palec, v pixelech (96 dpi), jak je bere knihovna docx. */
const MAX_IMAGE_WIDTH = 601;

function figureParagraph(s: Segment, images: Map<string, Buffer>) {
  const snap = s.snapshot;
  const data = snap && images.get(snap.file);
  if (!snap || !data || !snap.width || !snap.height) return null;
  const width = Math.min((snap.width * 4) / 3, MAX_IMAGE_WIDTH);
  const height = Math.round((width * snap.height) / snap.width);
  const run = new ImageRun({ type: 'png', data, transformation: { width: Math.round(width), height }, altText: { name: snap.file, description: snap.file, title: snap.file } });
  return new Paragraph({ children: [run], spacing: { before: 120, after: 120 } });
}

/** Načte výřezy tabulek a grafů ze složky úlohy; chybějící soubor se přeskočí. */
export async function loadFigures(dir: string, segments: Segment[]): Promise<Map<string, Buffer>> {
  const images = new Map<string, Buffer>();
  for (const s of segments) {
    if (!s.snapshot) continue;
    try {
      images.set(s.snapshot.file, await readFile(path.join(dir, s.snapshot.file)));
    } catch {
      /* obrázek chybí */
    }
  }
  return images;
}

export async function buildDocx(title: string, segments: Segment[], images: Map<string, Buffer> = new Map()): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const s of visibleSegments(segments)) {
    const figure = figureParagraph(s, images);
    if (figure && s.snapshot?.position === 'before') children.push(figure);
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
    if (figure && s.snapshot?.position !== 'before') children.push(figure);
  }
  const doc = new Document({
    title,
    creator: 'TransLatte',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
