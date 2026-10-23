import type { LinkArea, TextItem } from '../shared/pdf';
import type { Rect, Segment, SegmentKind, SegmentLink } from '../shared/types';

export interface Block {
  kind: SegmentKind;
  text: string;
  page?: number;
  /** Umístění na stránce z OCR (0–999) vůči obrázku stránky. */
  box?: [number, number, number, number];
  rects?: Rect[];
  fontSize?: number;
  serif?: boolean;
  bold?: boolean;
  centered?: boolean;
  /** Jen pro přeložené PDF, ve Srovnání ani v exportu se nezobrazí. */
  layoutOnly?: boolean;
  /** Tabulka z OCR přišla bez buněk (LM Studio zahazuje tokeny <tr>/<td> DeepSeek-OCR). */
  needsRepair?: boolean;
  warning?: string;
  links?: SegmentLink[];
}

const LIST_LINE = /^\s*([-*•–]|\d+[.)])\s+/;
const SKIPPED_OCR_LABELS = /^(header|footer|page[_-]?(number|header|footer)|image|figure|picture)$/i;

export function markdownToBlocks(md: string, page?: number): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.split(/\n\s*\n/)) {
    const text = raw.trim();
    if (!text || /^<!--.*-->$/s.test(text)) continue;
    const lines = text.split('\n');
    const heading = text.match(/^#{1,6}\s+(.+)$/s);
    if (heading && lines.length === 1) blocks.push({ kind: 'heading', text: heading[1].trim(), page });
    else if (lines.every((l) => l.trim().startsWith('|'))) blocks.push({ kind: 'table', text, page });
    else if (lines.every((l) => LIST_LINE.test(l))) blocks.push({ kind: 'list', text, page });
    else blocks.push({ kind: 'paragraph', text: lines.map((l) => l.trim()).join(' '), page });
  }
  return blocks;
}

/** OCR modely vracejí LaTeX zápis i u obyčejného textu („\(18\%\)“). */
function cleanOcrText(text: string) {
  return text
    .replace(/\\\((.*?)\\\)/g, '$1')
    .replace(/\\([%$&#_])/g, '$1')
    .trim();
}

function htmlTableToMarkdown(html: string): string | null {
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, '').replace(/\|/g, '/').trim(),
    ),
  );
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

/**
 * Výstup Unlimited-OCR (DeepSeek-OCR) má řádky „title [x1, y1, x2, y2]Text“.
 * Jiné vision modely vracejí obyčejný Markdown, ten se zpracuje jako Markdown.
 */
export function parseOcr(output: string, page: number, size?: { width: number; height: number }): Block[] {
  const lines = output.split('\n').filter((l) => l.trim());
  const labelled = /^(\w+) \[([\d.,\s]+)\](.*)$/;
  if (!lines.length || lines.filter((l) => labelled.test(l)).length < lines.length / 2) {
    return markdownToBlocks(output, page);
  }
  const blocks: Block[] = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(labelled);
    if (!m) {
      // Pokračování předchozího bloku (např. víceřádková tabulka).
      if (!skipping && blocks.length) blocks[blocks.length - 1].text += `\n${line}`;
      continue;
    }
    const [, label, coords, content] = m;
    skipping = SKIPPED_OCR_LABELS.test(label);
    if (skipping) continue;
    const text = cleanOcrText(content);
    if (!text) continue;
    const numbers = coords.split(',').map(Number);
    const box = numbers.length === 4 && numbers.every(Number.isFinite) ? (numbers as Block['box']) : undefined;
    if (/^title$|heading/i.test(label)) blocks.push({ kind: 'heading', text: text.replace(/^#+\s*/, ''), page, box });
    else if (/table/i.test(label)) blocks.push({ kind: 'table', text, page, box });
    else blocks.push(...splitBox(markdownToBlocks(text, page), box));
  }
  if (size) for (const block of blocks) Object.assign(block, ocrGeometry(block, size));
  for (const block of blocks) {
    if (block.kind === 'table' && /<table/i.test(block.text)) {
      const md = htmlTableToMarkdown(block.text);
      if (md) block.text = md;
      else {
        block.text = unstructuredTable(block.text);
        block.needsRepair = true;
      }
    }
  }
  return blocks;
}

/** Víc bloků z jednoho štítku OCR si rozdělí jeho výšku podle délky textu. */
function splitBox(blocks: Block[], box: Block['box']): Block[] {
  if (!box || blocks.length < 2) return blocks.map((b) => ({ ...b, box }));
  const [x0, y0, x1, y1] = box;
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  let top = y0;
  return blocks.map((b) => {
    const bottom = top + ((y1 - y0) * b.text.length) / total;
    const part = { ...b, box: [x0, Math.round(top), x1, Math.round(bottom)] as Block['box'] };
    top = bottom;
    return part;
  });
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Typické písmo bloku z plochy: znak zabere zhruba 0,5 × 1,2 velikosti písma. */
function estimateFontSize(w: number, h: number, chars: number) {
  return Math.min(h, Math.sqrt((w * h) / (0.6 * Math.max(1, chars))));
}

/** Box z OCR (0–999 vůči obrázku stránky) na obdélník v bodech stránky. */
export function ocrGeometry(block: Block, size: { width: number; height: number }): Pick<Block, 'rects' | 'fontSize' | 'bold'> {
  if (!block.box || block.page === undefined) return {};
  const [x0, y0, x1, y1] = block.box.map((v) => Math.min(999, Math.max(0, v)) / 999);
  const rect: Rect = {
    page: block.page,
    x: round(x0 * size.width),
    y: round(y0 * size.height),
    w: round((x1 - x0) * size.width),
    h: round((y1 - y0) * size.height),
    chars: block.text.length,
  };
  if (rect.w <= 0 || rect.h <= 0) return {};
  // Tabulka má mezi buňkami hodně volného místa, odhad z plochy by vyšel velký.
  const fontSize = estimateFontSize(rect.w, rect.h, block.text.length) * (block.kind === 'table' ? 0.6 : 1);
  return { rects: [rect], fontSize: round(fontSize), bold: block.kind === 'heading' };
}

/** Text tabulky bez hranic buněk; mezery se odhadnou na přechodech „slovoSlovo“ a „slovo123“. */
function unstructuredTable(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{L})/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown tabulka od vision modelu: spojí zalomené řádky a ověří, že má hlavičku a data. */
export function normalizeMarkdownTable(text: string): string | null {
  const rows: string[] = [];
  for (const raw of text.replace(/```\w*/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('|') || !rows.length) rows.push(line);
    else rows[rows.length - 1] += ` ${line}`;
  }
  const table = rows.filter((r) => r.startsWith('|')).map((r) => (r.endsWith('|') ? r : `${r} |`));
  const separator = table.findIndex((r) => /^\|[\s|:-]+\|$/.test(r));
  if (table.length < 3 || separator !== 1) return null;
  return table.join('\n');
}

interface Line {
  y: number;
  h: number;
  x0: number;
  x1: number;
  /** Úseky řádku oddělené velkou mezerou (sloupce tabulky), aby překrytí nesmazalo čáry mezi nimi. */
  spans: [number, number][];
  text: string;
  serif: boolean;
  bold: boolean;
}

/** Převažující vlastnost podle počtu znaků. */
function majority<T extends { str?: string; text?: string }>(list: T[], test: (t: T) => boolean | undefined) {
  const len = (t: T) => (t.str ?? t.text ?? '').length;
  const yes = list.filter(test).reduce((n, t) => n + len(t), 0);
  return yes * 2 > list.reduce((n, t) => n + len(t), 0);
}

/** Položky seskupené do řádků podle výšky na stránce, shora dolů. */
function toRows(items: TextItem[]) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { y: number; h: number; items: TextItem[] }[] = [];
  for (const item of sorted) {
    const row = rows.find((l) => Math.abs(l.y - item.y) < Math.max(l.h, item.h) * 0.5);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, h: item.h, items: [item] });
  }
  return rows.sort((a, b) => a.y - b.y);
}

/** Úseky řádku: položky s mezerou menší než `gap` × výška písma patří k sobě. */
function rowSpans(items: TextItem[], gap = 1): [number, number][] {
  const spans: [number, number][] = [];
  let end = -Infinity;
  for (const p of [...items].sort((a, b) => a.x - b.x)) {
    if (spans.length && p.x - end < p.h * gap) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], p.x + p.w);
    else spans.push([p.x, p.x + p.w]);
    end = Math.max(end, p.x + p.w);
  }
  return spans;
}

/** Iniciála: jedno velké písmeno na začátku odstavce přes několik řádků („M“ + „ost companies“). */
function isDropCap(part: TextItem, next: TextItem | undefined, others: TextItem[]) {
  return !!next && /^\p{Lu}$/u.test(part.str.trim()) && others.length > 0 && part.h > median(others.map((o) => o.h)) * 1.8 && /^\p{Ll}/u.test(next.str.trim());
}

function toLines(items: TextItem[]): Line[] {
  return toRows(items)
    .map((line) => {
      let parts = line.items.sort((a, b) => a.x - b.x);
      const dropCap = isDropCap(parts[0], parts[1], parts.slice(1)) ? parts[0] : undefined;
      if (dropCap) parts = [{ ...parts[1], str: dropCap.str.trim() + parts[1].str.trimStart(), x: dropCap.x, w: parts[1].x + parts[1].w - dropCap.x }, ...parts.slice(2)];
      let text = '';
      let end = -Infinity;
      for (const p of parts) {
        const gap = p.x - end;
        if (text && !text.endsWith(' ') && !p.str.startsWith(' ') && gap > p.h * 0.1) text += ' ';
        text += p.str;
        end = Math.max(end, p.x + p.w);
      }
      return {
        y: dropCap ? Math.min(...parts.map((p) => p.y)) : line.y,
        h: Math.max(...parts.map((p) => p.h)),
        x0: Math.min(...parts.map((p) => p.x)),
        x1: Math.max(...parts.map((p) => p.x + p.w)),
        spans: rowSpans(parts),
        text: text.replace(/\s+/g, ' ').trim(),
        serif: majority(parts, (p) => p.serif),
        bold: majority(parts, (p) => p.bold),
      };
    })
    .filter((l) => l.text);
}

// Dolní medián: u pár řádků by horní medián vzal mezeru mezi odstavci za běžné řádkování.
function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

interface Metrics {
  bodyHeight: number;
  lineGap: number;
  pageWidth: number;
}

function metrics(lines: Line[], pageWidth: number): Metrics {
  const bodyHeight = median(lines.map((l) => l.h));
  const gaps = lines.slice(1).map((l, i) => l.y - lines[i].y);
  return { bodyHeight, lineGap: median(gaps.filter((g) => g > 0)) || bodyHeight * 1.2, pageWidth };
}

// Metriky se berou z celé stránky: skupina nad sloupci (název článku) by jinak sama sebe brala za běžný text.
function linesToBlocks(lines: Line[], page: number, { bodyHeight, lineGap, pageWidth }: Metrics): Block[] {
  if (!lines.length) return [];
  const blocks: Block[] = [];
  const members = new Map<Block, Line[]>();
  let current: Block | null = null;
  lines.forEach((line, i) => {
    const isHeading = line.h > bodyHeight * 1.1 && line.text.length < 150;
    const prev = lines[i - 1];
    const gap = i ? line.y - prev.y : Infinity;
    // „2012. Beginning…“ uprostřed nedokončené věty je pokračování, ne číslovaný seznam.
    const continuesSentence = current?.kind === 'paragraph' && gap <= lineGap * 1.5 && !SENTENCE_END.test(current.text);
    const isList = LIST_LINE.test(line.text) && !continuesSentence;
    // Dvouřádkový nadpis (stejné písmo, těsně pod sebou) zůstane jedním nadpisem; zvýrazněný citát
    // mívá větší řádkování, ale pokračování začíná malým písmenem.
    const headingContinues =
      isHeading &&
      current?.kind === 'heading' &&
      Math.abs(prev.h - line.h) < 0.5 &&
      (gap < line.h * 1.6 || (/^\p{Ll}/u.test(line.text) && gap < line.h * 3));
    const startsNew =
      !headingContinues &&
      (!current || isHeading || current.kind === 'heading' || gap > lineGap * 1.5 || (isList && current.kind !== 'list'));
    if (startsNew) {
      current = { kind: isHeading ? 'heading' : isList ? 'list' : 'paragraph', text: line.text, page };
      blocks.push(current);
      members.set(current, [line]);
      return;
    }
    members.get(current!)!.push(line);
    if (current!.kind === 'list' && isList) {
      current!.text += `\n${line.text}`;
    } else if (/[\p{L}]-$/u.test(current!.text) && /^\p{Ll}/u.test(line.text)) {
      current!.text = current!.text.slice(0, -1) + line.text; // rozdělené slovo na konci řádku
    } else {
      current!.text += ` ${line.text}`;
    }
  });
  for (const block of blocks) {
    // Delší text většího písma (medailonek autora vedle drobných referencí) není nadpis.
    if (block.kind === 'heading' && (members.get(block)!.length > 3 || block.text.length > 200)) block.kind = 'paragraph';
    Object.assign(block, lineGeometry(members.get(block)!, page, block, pageWidth));
  }
  return blocks;
}

/** Obálka řádků bloku; dolní okraj včetně dotažnic (účaří je na y + h). */
function lineGeometry(lines: Line[], page: number, block: Block, pageWidth: number): Pick<Block, 'rects' | 'fontSize' | 'serif' | 'bold' | 'centered'> {
  const top = Math.min(...lines.map((l) => l.y));
  const bottom = Math.max(...lines.map((l) => l.y + l.h * 1.2));
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const cover = lines.flatMap((l) => l.spans.map(([a, b]) => [round(a), round(l.y), round(b - a), round(l.h * 1.2)] as [number, number, number, number]));
  const rect: Rect = { page, x: round(x0), y: round(top), w: round(x1 - x0), h: round(bottom - top), chars: block.text.length, cover };
  // Na střed: víc řádků se stejným středem a různým začátkem, nebo jeden kratší řádek uprostřed stránky.
  const centers = lines.map((l) => (l.x0 + l.x1) / 2);
  const centered =
    lines.length > 1
      ? Math.max(...centers) - Math.min(...centers) < 3 && Math.max(...lines.map((l) => l.x0)) - x0 > 6
      : Math.abs(centers[0] - pageWidth / 2) < pageWidth * 0.01 && x1 - x0 < pageWidth * 0.7;
  return {
    rects: [rect],
    fontSize: round(median(lines.map((l) => l.h))),
    serif: majority(lines, (l) => l.serif),
    bold: block.kind === 'heading' || majority(lines, (l) => l.bold),
    ...(centered && { centered }),
  };
}

/**
 * Bloky z OCR na digitální stránce: písmo, typ a plochy řádků podle textové vrstvy pod boxem
 * (velikost odhadnutá z boxu bývá nepřesná a celý box by překryl i čáry tabulky).
 */
export function textLayerGeometry(blocks: Block[], items: TextItem[], pageWidth: number) {
  const real = items.filter((i) => i.str.trim());
  for (const block of blocks) {
    const rect = block.rects?.[0];
    if (!rect || block.rects!.length > 1) continue;
    const inside = real.filter((i) => {
      const cx = i.x + i.w / 2;
      const cy = i.y + i.h / 2;
      return cx >= rect.x - 3 && cx <= rect.x + rect.w + 3 && cy >= rect.y - 3 && cy <= rect.y + rect.h + 3;
    });
    const lines = toLines(inside);
    if (!lines.length) continue;
    const { rects, ...style } = lineGeometry(lines, rect.page, block, pageWidth);
    Object.assign(block, style, { rects: [{ ...rects![0], chars: rect.chars }] });
  }
}

const TABLE_CAPTION = /^(table|tab\.|tabulka|tabelle)\s*\d+[.:]/i;

/**
 * Tabulka nakreslená křivkami nebo vložená jako obrázek nemá textovou vrstvu, pod popiskem
 * „Table N.“ pak zůstane prázdné místo. Z něj se udělá tabulka k přečtení vision modelem z výřezu stránky.
 */
export function addUnreadableTables(blocks: Block[], items: TextItem[], size: { width: number; height: number }): Block[] {
  const real = items.filter((i) => i.str.trim());
  const out: Block[] = [];
  for (const b of blocks) {
    out.push(b);
    const r = b.rects?.[0];
    if (b.kind === 'table' || !r || b.rects!.length > 1 || !TABLE_CAPTION.test(b.text)) continue;
    const top = r.y + r.h;
    // Popisek přes střed stránky patří k tabulce přes celou šířku textu.
    const wide = r.x < size.width / 2 && r.x + r.w > size.width / 2;
    const x0 = wide ? Math.min(...real.map((i) => i.x)) : r.x;
    const x1 = wide ? Math.max(...real.map((i) => i.x + i.w)) : r.x + r.w;
    const below = real.filter((i) => i.y >= top - 1 && i.x < x1 && i.x + i.w > x0).map((i) => i.y);
    const bottom = Math.min(size.height * 0.92, ...below);
    if (bottom - top < (b.fontSize ?? 10) * 5) continue;
    const box = [x0 / size.width, top / size.height, x1 / size.width, bottom / size.height].map((v) => Math.round(v * 999)) as Block['box'];
    out.push({ kind: 'table', text: '', page: b.page, box, needsRepair: true });
  }
  return out;
}

/** Svislá mezera mezi sloupci: nejdelší úsek kolem středu stránky, který nepřekrývá žádný úsek řádku. */
function gutterCenter(spans: [number, number][], pageWidth: number) {
  const mid = pageWidth / 2;
  let best = { len: -1, center: mid };
  let start: number | null = null;
  for (let x = Math.floor(mid - pageWidth * 0.12); x <= mid + pageWidth * 0.12 + 1; x++) {
    const free = x <= mid + pageWidth * 0.12 && !spans.some(([a, b]) => a < x && b > x);
    if (free && start === null) start = x;
    if (!free && start !== null) {
      if (x - start > best.len) best = { len: x - start, center: (start + x - 1) / 2 };
      start = null;
    }
  }
  return best.center;
}

/**
 * Textová vrstva PDF → bloky. Stránka se dělí na vodorovné pásy: řádky přes střed stránky
 * (název, abstrakt, široká tabulka) se čtou celé, pásy dvou sloupců nejdřív vlevo, pak vpravo,
 * jinak by se řádky obou sloupců prolínaly.
 */
export function layoutToBlocks(items: TextItem[], pageWidth: number, page: number): Block[] {
  const real = items.filter((i) => i.str.trim());
  if (!real.length) return [];
  const mid = pageWidth / 2;
  const tolerance = pageWidth * 0.02;
  const rows = toRows(real).map((row) => {
    // Užší práh než u ploch řádku: mezera mezi sloupci bývá jen o málo větší než písmo.
    const spans = rowSpans(row.items, 0.6);
    return { items: row.items, spans, spanning: spans.some(([a, b]) => a < mid - tolerance && b > mid + tolerance) };
  });

  // Pás dvou sloupců: aspoň tři řádky textu na každé straně a řádky široké jako sloupec
  // (tabulka s krátkými buňkami se na sloupce nedělí).
  const groups: TextItem[][] = [];
  let full: TextItem[] = [];
  const flush = () => {
    if (full.length) groups.push(full);
    full = [];
  };
  for (let i = 0; i < rows.length; ) {
    if (rows[i].spanning) {
      full.push(...rows[i++].items);
      continue;
    }
    const band: typeof rows = [];
    while (i < rows.length && !rows[i].spanning) band.push(rows[i++]);
    const gutter = gutterCenter(band.flatMap((r) => r.spans), pageWidth);
    const side = (r: (typeof band)[number], left: boolean) => r.spans.filter(([a, b]) => (a + b) / 2 < gutter === left);
    const widths = (left: boolean) => band.map((r) => side(r, left)).filter((s) => s.length).map((s) => Math.max(...s.map(([, b]) => b)) - Math.min(...s.map(([a]) => a)));
    const columnar = (w: number[]) => w.filter((x) => x > pageWidth * 0.25).length >= 3;
    if (!columnar(widths(true)) || !columnar(widths(false))) {
      for (const r of band) full.push(...r.items);
      continue;
    }
    flush();
    const items = band.flatMap((r) => r.items);
    groups.push(items.filter((it) => it.x + it.w / 2 < gutter), items.filter((it) => it.x + it.w / 2 >= gutter));
  }
  flush();

  const lines = groups.map((g) => toLines(g));
  const pageMetrics = metrics(lines.flat(), pageWidth);
  const blocks: Block[] = [];
  for (const group of lines) {
    const [first, ...rest] = linesToBlocks(group, page, pageMetrics);
    if (!first) continue;
    // Odstavec přetékající do dalšího sloupce; popisky obrázků mezi nimi se přeskočí.
    const open = blocks.findLast((b) => !isAside(b, first));
    if (open && continuesInto(open, first)) joinInto(open, first);
    else blocks.push(first);
    blocks.push(...rest);
  }
  return blocks;
}

/** Slova textové položky s odhadnutým středem; šířka znaku se bere úměrně délce položky. */
function itemWords(item: TextItem) {
  const per = item.str.length ? item.w / item.str.length : 0;
  return [...item.str.matchAll(/\S+/g)].map((m) => ({ text: m[0], x: item.x + (m.index + m[0].length / 2) * per, y: item.y + item.h / 2, h: item.h }));
}

/**
 * Text odkazů na stránce: slova textové vrstvy, jejichž střed leží v klikací ploše.
 * Odkaz zalomený přes řádek má anotaci na každém řádku, ty se spojí.
 */
export function linkAnchors(items: TextItem[], links: LinkArea[], page: number): SegmentLink[] {
  const words = items.flatMap(itemWords);
  const result: SegmentLink[] = [];
  for (const link of [...links].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const inside = words.filter((w) => w.x >= link.x && w.x <= link.x + link.w && w.y >= link.y && w.y <= link.y + link.h);
    if (!inside.length) continue;
    const lineHeight = median(inside.map((w) => w.h));
    // Plocha přes několik řádků (lišta webu, logo) není odkaz v textu.
    if (link.h > lineHeight * 2.5) continue;
    const text = inside
      .sort((a, b) => (Math.abs(a.y - b.y) > lineHeight / 2 ? a.y - b.y : a.x - b.x))
      .map((w) => w.text)
      .join(' ');
    const rect: Rect = { page, x: round(link.x), y: round(link.y), w: round(link.w), h: round(link.h) };
    const prev = result[result.length - 1];
    const last = prev?.rects[prev.rects.length - 1];
    if (prev && link.url && prev.url === link.url && last && rect.y - last.y > lineHeight * 0.5 && rect.y - last.y < lineHeight * 2.5) {
      prev.source = /\p{L}-$/u.test(prev.source) && /^\p{Ll}/u.test(text) ? prev.source.slice(0, -1) + text : `${prev.source} ${text}`;
      prev.rects.push(rect);
    } else result.push({ ...(link.url && { url: link.url }), source: text, rects: [rect] });
  }
  return result;
}

/** Odkazy se přiřadí bloku, v jehož ploše řádků leží začátek odkazu (tabulky se překládají po buňkách, ty ne). */
export function attachLinks(blocks: Block[], links: SegmentLink[]) {
  for (const link of links) {
    const r = link.rects[0];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const block = blocks.find(
      (b) =>
        b.kind !== 'table' &&
        b.rects?.some((rect) => rect.page === r.page && (rect.cover ?? [[rect.x, rect.y, rect.w, rect.h]]).some(([x, y, w, h]) => cx >= x - 2 && cx <= x + w + 2 && cy >= y - 2 && cy <= y + h + 2)),
    );
    if (block) (block.links ??= []).push(link);
  }
}

/**
 * Záhlaví a zápatí: krátký text na stejném místě na více stránkách (lišta webu, název časopisu)
 * a samotná čísla stránek u horního nebo dolního okraje. Časopisy střídají živé záhlaví
 * (autoři na sudých, název článku na lichých stránkách), u okraje proto stačí opakování
 * na polovině stránek stejné parity.
 */
export function removePageFurniture(pages: { items: TextItem[]; height: number }[]): TextItem[][] {
  const key = (i: TextItem) => `${i.str.trim()}|${Math.round(i.y / 4)}`;
  const inMargin = (i: TextItem, height: number) => i.y < height * 0.12 || i.y > height * 0.88;
  const seen = new Map<string, Set<number>>();
  pages.forEach((p, n) => {
    for (const i of p.items) {
      const len = i.str.trim().length;
      if (!len || len > (inMargin(i, p.height) ? 120 : 60)) continue;
      if (!seen.has(key(i))) seen.set(key(i), new Set());
      seen.get(key(i))!.add(n);
    }
  });
  const repeated = (i: TextItem, n: number, height: number) => {
    const on = seen.get(key(i));
    if (pages.length < 2 || !on) return false;
    if (on.size >= Math.max(2, pages.length / 2)) return true;
    const sameParity = [...on].filter((m) => m % 2 === n % 2).length;
    return inMargin(i, height) && pages.length >= 4 && sameParity >= Math.max(2, Math.ceil(pages.length / 2) / 2);
  };
  return pages.map((p, n) =>
    p.items.filter((i) => {
      const nearEdge = i.y < p.height * 0.07 || i.y > p.height * 0.93;
      return !repeated(i, n, p.height) && !(nearEdge && /^\s*\d{1,3}\s*$/.test(i.str));
    }),
  );
}

/** Stejné krátké bloky na většině stránek (záhlaví z OCR) se zahodí. */
export function dropRepeatedBlocks(blocks: Block[]): Block[] {
  const pages = new Set(blocks.map((b) => b.page)).size;
  if (pages < 2) return blocks;
  const onPages = new Map<string, Set<number | undefined>>();
  for (const b of blocks) {
    if (b.text.length > 60) continue;
    if (!onPages.has(b.text)) onPages.set(b.text, new Set());
    onPages.get(b.text)!.add(b.page);
  }
  return blocks.filter((b) => (onPages.get(b.text)?.size ?? 0) < Math.max(2, pages / 2));
}

const SENTENCE_END = /[.!?:;…"”'’)\]]$/;

/**
 * Odstavec rozdělený koncem stránky se spojí. Jinak by se obě půlky překládaly zvlášť
 * a model by první dokončil vymyšleným koncem.
 */
export function mergeAcrossPages(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const open = b.page !== undefined ? openOnPreviousPage(out, b) : undefined;
    if (open && continuesInto(open, b)) joinInto(open, b);
    else out.push({ ...b });
  }
  return out;
}

/**
 * Poslední blok předchozí stránky, na který může `b` navazovat. Přeskočí se popisky, tabulky
 * a krátké štítky grafů na konci předchozí i na začátku stránky `b`.
 */
function openOnPreviousPage(out: Block[], b: Block) {
  for (let i = out.length - 1; i >= 0; i--) {
    const x = out[i];
    if (x.page === b.page) {
      if (isAside(x, b) || x.text.length < 40) continue;
      return undefined;
    }
    if (x.page !== b.page! - 1) return undefined;
    if (!isAside(x, b) && x.text.length >= 40) return x;
  }
  return undefined;
}

/** Písmo z OCR je jen odhad z plochy boxu, porovnává se jen u textové vrstvy. */
const comparableFont = (a: Block, b: Block) => !a.box && !b.box && !!a.fontSize && !!b.fontSize;

/** Vedlejší blok vůči běžnému textu `body`: tabulka nebo menší písmo (popisek, štítek grafu). */
function isAside(x: Block, body: Block) {
  return x.kind === 'table' || (comparableFont(x, body) && x.fontSize! < body.fontSize! - 0.5);
}

function continuesInto(prev: Block, next: Block) {
  return (
    prev.kind === 'paragraph' &&
    next.kind === 'paragraph' &&
    // Krátký řádek bez tečky (hashtag, podpis) není useknutý odstavec.
    prev.text.length >= 80 &&
    !SENTENCE_END.test(prev.text.trim()) &&
    // Lišta webu (souhlas s cookies) opakovaná na další stránce není pokračování.
    !prev.text.endsWith(next.text) &&
    (!comparableFont(prev, next) || Math.abs(prev.fontSize! - next.fontSize!) <= 0.5)
  );
}

function joinInto(prev: Block, b: Block) {
  prev.text = /\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(b.text) ? prev.text.slice(0, -1) + b.text : `${prev.text} ${b.text}`;
  if (b.warning) prev.warning ??= b.warning;
  joinRects(prev, b);
}

/** Nadpis rozdělený na dva bloky (pokračování začíná malým písmenem) se spojí, typicky citát z OCR. */
export function mergeBrokenHeadings(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev?.kind === 'heading' && b.kind === 'heading' && prev.page === b.page && /^\p{Ll}/u.test(b.text)) {
      prev.text = `${prev.text} ${b.text}`;
      joinRects(prev, b);
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

function joinRects(into: Block, from: Block) {
  if (into.rects || from.rects) into.rects = [...(into.rects ?? []), ...(from.rects ?? [])];
  if (into.links || from.links) into.links = [...(into.links ?? []), ...(from.links ?? [])];
}

const normalized = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

/**
 * Zvýrazněný citát opakuje větu z článku; ve Srovnání a exportu by byl dvakrát.
 * Blok, jehož text je celý obsažený v jiném bloku, se přeloží jen pro přeložené PDF
 * (u shody zůstane viditelný odstavec, ne nadpis).
 */
export function markDuplicateBlocks(blocks: Block[]): Block[] {
  const norms = blocks.map((b) => normalized(b.text));
  return blocks.map((b, i) => {
    if (norms[i].length < 40 || b.kind === 'table') return b;
    const duplicate = norms.some((other, j) => {
      if (j === i || !other.includes(norms[i])) return false;
      if (other.length > norms[i].length) return true;
      // Stejný text: skrýt nadpis před odstavcem, u stejného druhu pozdější výskyt.
      return blocks[j].kind === b.kind ? j < i : b.kind === 'heading';
    });
    return duplicate ? { ...b, layoutOnly: true } : b;
  });
}

/** TranslateGemma přidává tečku i za nadpis nebo položku bez tečky. */
export function stripAddedPeriod(source: string, translation: string) {
  return !/[.!?…]$/.test(source.trim()) && /[^.]\.$/.test(translation.trim()) ? translation.trim().slice(0, -1) : translation;
}

export function blocksToSegments(blocks: Block[]): Segment[] {
  // Samotné symboly (☰, ikony z webu) nejsou text k překladu.
  return blocks
    .filter((b) => /[\p{L}\p{N}]/u.test(b.text))
    .map((b, id) => ({
      id,
      kind: b.kind,
      page: b.page,
      source: b.text,
      ...(b.warning && { warning: b.warning }),
      ...(b.rects?.length && { rects: b.rects, fontSize: b.fontSize, serif: b.serif, bold: b.bold, centered: b.centered }),
      ...(b.layoutOnly && { layoutOnly: true }),
      ...(b.links?.length && { links: b.links }),
    }));
}

/** Indexy segmentů seskupené do dávek pro překlad; tabulky jdou samostatně. */
export function groupSegments(segments: Segment[], maxChars: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let size = 0;
  for (const [i, s] of segments.entries()) {
    if (s.kind === 'table' || s.source.length > maxChars) {
      if (current.length) groups.push(current);
      groups.push([i]);
      current = [];
      size = 0;
      continue;
    }
    if (current.length && size + s.source.length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += s.source.length + 2;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Rozdělí dlouhý odstavec po větách na části do `max` znaků (věta se nikdy nedělí). */
export function sentenceChunks(text: string, max: number): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+(?=[\p{Lu}\d"„“(])/u);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + sentence.length + 1 <= max) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}

/** Rozdělí přeloženou dávku zpět na segmenty; null, když model sloučil nebo rozdělil odstavce. */
export function splitBatch(text: string, expected: number): string[] | null {
  // Jediný odstavec v dávce: že ho model rozdělil na dva, nevadí.
  if (expected === 1) return text.trim() ? [text.trim().replace(/\s*\n\s*\n\s*/g, ' ')] : null;
  const parts = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length === expected ? parts : null;
}

export const finalText = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? s.source;

/** Segmenty pro Srovnání, Překlad a export (bez těch, které jsou jen pro přeložené PDF). */
export const visibleSegments = (segments: Segment[]) => segments.filter((s) => !s.layoutOnly);

export function segmentsToMarkdown(segments: Segment[], text: (s: Segment) => string = finalText): string {
  return visibleSegments(segments)
    .map((s) => (s.kind === 'heading' ? `## ${text(s).replace(/^#+\s*/, '')}` : text(s)))
    .join('\n\n');
}
