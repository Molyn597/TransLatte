// Skryté okno: pdf.js potřebuje canvas a web worker, které hlavní proces nemá.
import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import { PDFJS_OPTIONS, unshiftText, type LinkArea, type PdfBridge, type PdfTask, type TextItem } from '../shared/pdf';

declare global {
  interface Window {
    pdfBridge: PdfBridge;
  }
}

GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

const SHOW_TEXT = new Set<number>([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
// Režimy vykreslení textu 3 a 7 jsou neviditelné (textová vrstva OCR nad skenem).
const INVISIBLE_MODES = new Set([3, 7]);

// V pdf.js 6 se dokument uvolňuje přes loading task.
const docs = new Map<string, { task: PDFDocumentLoadingTask; pdf: PDFDocumentProxy }>();

function doc(docId: string) {
  const d = docs.get(docId);
  if (!d) throw new Error(`PDF ${docId} není otevřené`);
  return d.pdf;
}

async function run(task: PdfTask): Promise<unknown> {
  switch (task.op) {
    case 'open': {
      // fontExtraProperties: název písma, podle kterého se pozná tučné.
      const loading = getDocument({ data: task.data, ...PDFJS_OPTIONS, fontExtraProperties: true });
      const pdf = await loading.promise;
      docs.set(task.docId, { task: loading, pdf });
      return { pages: pdf.numPages };
    }
    case 'text': {
      const page = await doc(task.docId).getPage(task.page);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const [vx, , , vy] = page.view;
      const items: TextItem[] = [];
      const fonts: string[] = [];
      let turned = 0;
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        const [, b, c, d, e, f] = item.transform as number[];
        // Otočený text (osy grafů, tabulka na šířku) zůstane v PDF původní, nepřekládá se.
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) {
          turned += item.str.trim().length;
          continue;
        }
        const h = item.height || Math.abs(d);
        // pdf.js má počátek vlevo dole a f je účaří; převod na horní okraj řádku vůči výřezu stránky.
        items.push({ str: unshiftText(item.str), x: e - vx, y: vy - f - h, w: item.width, h, serif: content.styles[item.fontName]?.fontFamily === 'serif' });
        fonts.push(item.fontName);
      }
      let invisible = false;
      if (items.length) {
        // Název písma (podle něj tučné) pdf.js předá až s operátory stránky.
        const ops = await page.getOperatorList();
        let mode = 0;
        let shown = 0;
        let hidden = 0;
        ops.fnArray.forEach((fn, i) => {
          if (fn === OPS.setTextRenderingMode) mode = ops.argsArray[i][0];
          else if (SHOW_TEXT.has(fn)) INVISIBLE_MODES.has(mode) ? hidden++ : shown++;
        });
        invisible = hidden > 0 && hidden >= (shown + hidden) * 0.9;
        const bold = new Map<string, boolean>();
        for (const key of new Set(fonts)) {
          const name = page.commonObjs.has(key) ? ((page.commonObjs.get(key) as { name?: string }).name ?? '') : '';
          bold.set(key, /bold|black|heavy|semibold|demi/i.test(name));
        }
        items.forEach((item, i) => (item.bold = bold.get(fonts[i])));
      }
      const links: LinkArea[] = [];
      for (const a of await page.getAnnotations({ intent: 'display' })) {
        if (a.subtype !== 'Link' || !a.rect) continue;
        const [x0, y0, x1, y1] = a.rect as number[];
        links.push({ ...(a.url && { url: a.url as string }), x: Math.min(x0, x1) - vx, y: vy - Math.max(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
      }
      page.cleanup();
      return { items, turned, width: viewport.width, height: viewport.height, view: [...page.view], rotate: page.rotate, invisible, links };
    }
    case 'render': {
      const page = await doc(task.docId).getPage(task.page);
      const viewport = page.getViewport({ scale: task.scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // pdf.js stránku podkreslí bílou, OCR tak nedostane průhledné pozadí.
      // Bez textu: porovnáním s běžným vykreslením se pozná text schovaný pod jiným obsahem.
      const operationsFilter = task.noText ? (i: number, list: { fnArray: number[] }) => !SHOW_TEXT.has(list.fnArray[i]) : undefined;
      await page.render({ canvas, viewport, operationsFilter } as Parameters<typeof page.render>[0]).promise;
      page.cleanup();
      if (!task.crop) return canvas.toDataURL('image/png');
      const [x0, y0, x1, y1] = task.crop.map((v) => Math.min(1, Math.max(0, v)));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x1 - x0) * canvas.width));
      out.height = Math.max(1, Math.round((y1 - y0) * canvas.height));
      out.getContext('2d')!.drawImage(canvas, -x0 * canvas.width, -y0 * canvas.height);
      return out.toDataURL('image/png');
    }
    case 'close':
      await docs.get(task.docId)?.task.destroy();
      docs.delete(task.docId);
      return null;
  }
}

window.pdfBridge.onTask((id, task) => {
  run(task).then(
    (result) => window.pdfBridge.reply(id, result),
    (error: Error) => window.pdfBridge.reply(id, null, error.message || String(error)),
  );
});
