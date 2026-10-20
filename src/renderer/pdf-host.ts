// Skryté okno: pdf.js potřebuje canvas a web worker, které hlavní proces nemá.
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import { PDFJS_OPTIONS, type PdfBridge, type PdfTask, type TextItem } from '../shared/pdf';

declare global {
  interface Window {
    pdfBridge: PdfBridge;
  }
}

GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

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
      const loading = getDocument({ data: task.data, ...PDFJS_OPTIONS });
      const pdf = await loading.promise;
      docs.set(task.docId, { task: loading, pdf });
      return { pages: pdf.numPages };
    }
    case 'text': {
      const page = await doc(task.docId).getPage(task.page);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        const [, , , d, e, f] = item.transform as number[];
        const h = item.height || Math.abs(d);
        // pdf.js má počátek vlevo dole a f je účaří; převod na horní okraj řádku.
        items.push({ str: item.str, x: e, y: viewport.height - f - h, w: item.width, h });
      }
      return { items, width: viewport.width, height: viewport.height };
    }
    case 'render': {
      const page = await doc(task.docId).getPage(task.page);
      const viewport = page.getViewport({ scale: task.scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // pdf.js stránku podkreslí bílou, OCR tak nedostane průhledné pozadí.
      await page.render({ canvas, viewport }).promise;
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
