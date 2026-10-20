import { contextBridge, ipcRenderer } from 'electron';
import type { PdfBridge } from '../shared/pdf';

const bridge: PdfBridge = {
  onTask: (handler) => ipcRenderer.on('pdf-task', (_e, id, task) => handler(id, task)),
  reply: (id, result, error) => ipcRenderer.send('pdf-result', id, result, error),
};

contextBridge.exposeInMainWorld('pdfBridge', bridge);
