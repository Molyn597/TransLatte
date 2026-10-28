import { describe, expect, it } from 'vitest';
import { PDFDocument as Encrypting } from '@cantoo/pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { decryptPdf } from '../src/main/layout-pdf';

async function encryptedPdf() {
  const doc = await Encrypting.create();
  doc.addPage([200, 200]).drawText('Hello', { x: 20, y: 100 });
  // Jen heslo vlastníka (zákaz úprav), otevřít jde bez hesla – jako u časopiseckých PDF.
  doc.encrypt({ userPassword: '', ownerPassword: 'owner' });
  return doc.save();
}

describe('decryptPdf', () => {
  it('šifrované PDF bez hesla k otevření načte pdf-lib po rozšifrování', async () => {
    const input = await encryptedPdf();
    await expect(PDFDocument.load(input)).rejects.toThrow(/encrypted/);
    const doc = await PDFDocument.load(await decryptPdf(input));
    expect(doc.isEncrypted).toBe(false);
    expect(doc.getPageCount()).toBe(1);
  });

  it('nešifrované PDF vrátí beze změny', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const input = await doc.save();
    expect(await decryptPdf(input)).toBe(input);
  });
});
