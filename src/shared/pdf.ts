// Zprávy mezi hlavním procesem a skrytým oknem s pdf.js.

/** Textová položka z pdf.js převedená do souřadnic s počátkem vlevo nahoře. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  serif?: boolean;
  bold?: boolean;
}

/** Klikací plocha odkazu (anotace Link) ve stejných souřadnicích jako TextItem. */
export interface LinkArea {
  /** Bez URL je to odkaz na místo v dokumentu. */
  url?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PdfTask =
  | { op: 'open'; docId: string; data: Uint8Array }
  | { op: 'text'; docId: string; page: number }
  /** crop: výřez [x0, y0, x1, y1] jako podíl šířky/výšky stránky (0–1). */
  | { op: 'render'; docId: string; page: number; scale: number; crop?: [number, number, number, number]; noText?: boolean }
  | { op: 'close'; docId: string };

export interface PdfOpenResult {
  pages: number;
}

export interface PdfTextResult {
  items: TextItem[];
  /** Znaků otočeného textu, který v `items` není (zůstane v PDF původní). */
  turned: number;
  width: number;
  height: number;
  /** pdf.js `view` (výřez cropBox v uživatelských souřadnicích PDF) a otočení stránky. */
  view: [number, number, number, number];
  rotate: number;
  /** Text stránky je neviditelný (textová vrstva OCR nad skenem). */
  invisible: boolean;
  links: LinkArea[];
}

/** PNG jako data URL, rovnou použitelné pro vision model. */
export type PdfRenderResult = string;

export interface PdfBridge {
  onTask(handler: (id: number, task: PdfTask) => void): void;
  reply(id: number, result: unknown, error?: string): void;
}

/** Volby pdf.js sdílené náhledem v UI i skrytým oknem (cesty vůči dist/). */
export const PDFJS_OPTIONS = {
  cMapUrl: './pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './pdfjs/standard_fonts/',
  wasmUrl: './pdfjs/wasm/',
  iccUrl: './pdfjs/iccs/',
  isEvalSupported: false,
};

// Písma z japonského MS Office mívají ToUnicode posunuté o pevnou hodnotu do bloku CJK rozšíření A
// („㻝㻢㻜㻜“ je „1600“, „㻌“ mezera). Převádí se jen text, který je takhle posunutý skoro celý.
const SHIFT = 0x3eac;
const shifted = (code: number) => code >= 0x20 + SHIFT && code <= 0x7e + SHIFT;

export function unshiftText(str: string): string {
  const chars = [...str].filter((c) => c.trim());
  if (!chars.length) return str;
  const count = chars.filter((c) => shifted(c.codePointAt(0)!)).length;
  if (count < chars.length * 0.8) return str;
  return [...str].map((c) => (shifted(c.codePointAt(0)!) ? String.fromCharCode(c.codePointAt(0)! - SHIFT) : c)).join('');
}
