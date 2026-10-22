import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api } from '../shared/types';

const api: Api = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings'),
  saveSettings: (settings) => ipcRenderer.invoke('settings-save', settings),
  getGlossary: () => ipcRenderer.invoke('glossary'),
  saveGlossary: (entries) => ipcRenderer.invoke('glossary-save', entries),
  lmStatus: () => ipcRenderer.invoke('lm-status'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  addJobs: (paths, options) => ipcRenderer.invoke('jobs-add', paths, options),
  listJobs: () => ipcRenderer.invoke('jobs'),
  getJob: (id) => ipcRenderer.invoke('job', id),
  readInput: (id) => ipcRenderer.invoke('job-input', id),
  readOutputPdf: (id) => ipcRenderer.invoke('job-output-pdf', id),
  cancelJob: (id) => ipcRenderer.invoke('job-cancel', id),
  retryJob: (id, mode) => ipcRenderer.invoke('job-retry', id, mode),
  deleteJob: (id) => ipcRenderer.invoke('job-delete', id),
  openOutput: (id, kind) => ipcRenderer.invoke('job-open', id, kind),
  revealOutput: (id) => ipcRenderer.invoke('job-reveal', id),
  saveOutputAs: (id) => ipcRenderer.invoke('job-save-as', id),
  onJobUpdate: (handler) => ipcRenderer.on('job-update', (_e, job) => handler(job)),
  onJobRemoved: (handler) => ipcRenderer.on('job-removed', (_e, id) => handler(id)),
  onOpenJob: (handler) => ipcRenderer.on('open-job', (_e, id) => handler(id)),
};

contextBridge.exposeInMainWorld('api', api);
