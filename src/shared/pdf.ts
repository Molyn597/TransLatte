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
