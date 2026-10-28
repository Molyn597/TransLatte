import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { resolveLang, setLang, t, type MessageKey } from '../shared/i18n';
import { languageName } from '../shared/languages';
import { findRegion, normalizeCrop } from '../shared/regions';
import type { GlossaryEntry, Job, JobOptions, Mode, OutputKind, Provider, RegionTranslation, Settings, Stage } from '../shared/types';
import { isOnline } from '../shared/provider';
import { fileInfo } from './fileinfo';
import { usdCzk } from './fx';
import { clearKey, readKey, saveKey } from './keystore';
import { status } from './lmstudio';
import { openrouterStatus, refreshCatalog } from './provider';
import { relayoutJob, translateRegion } from './pipeline';
import { Queue, SUPPORTED } from './queue';
import { Store } from './store';

const isMac = process.platform === 'darwin';
const TITLE_BAR = {
  light: { color: '#f3ede6', symbolColor: '#2b211b' },
  dark: { color: '#17130f', symbolColor: '#f1e9df' },
};
const STAGE_LABEL: Record<Stage, MessageKey> = {
  prepare: 'tray.stage.prepare',
  extract: 'tray.stage.extract',
  ocr: 'tray.stage.ocr',
  tables: 'tray.stage.tables',
  context: 'tray.stage.context',
  translate: 'tray.stage.translate',
  check: 'tray.stage.check',
  fix: 'tray.stage.fix',
  write: 'tray.stage.write',
  layout: 'tray.stage.layout',
};

if (process.env.TRANSLATTE_USER_DATA) app.setPath('userData', process.env.TRANSLATTE_USER_DATA);

const store = new Store(app.getPath('userData'));
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
const active = new Map<string, Job>();

const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args);

const queue = new Queue(store, {
  update(job) {
    if (job.status === 'running' || job.status === 'queued') active.set(job.id, job);
    else active.delete(job.id);
    send('job-update', job);
    updateProgressUi();
  },
  async finished(job) {
    const settings = await store.settings();
    if (!settings.notify || !Notification.isSupported()) return;
    if (job.status !== 'done' && job.status !== 'error') return;
    const n = new Notification({
      title: job.status === 'done' ? t('notify.done') : t('notify.failed'),
      body:
        job.status === 'done'
          ? job.warnings
            ? t('notify.doneWarnings', { name: job.name, lang: languageName(job.targetLang), count: job.warnings })
            : t('notify.doneBody', { name: job.name, lang: languageName(job.targetLang) })
          : `${job.name}: ${job.error ?? ''}`.slice(0, 200),
      silent: false,
    });
    n.on('click', () => {
      showWindow();
      send('open-job', job.id);
    });
    n.show();
  },
  idle: () => updateProgressUi(),
});

/** Celkový průběh z uplynulého času a odhadu zbytku; průběh fáze by u každé fáze začínal od nuly. */
function overallProgress(job: Job) {
  const eta = job.progress?.eta;
  if (eta === undefined || !job.startedAt) return -1;
  const elapsed = (Date.now() - job.startedAt) / 1000;
  return Math.min(0.99, elapsed / (elapsed + eta));
}

function updateProgressUi() {
  const running = [...active.values()].find((j) => j.status === 'running');
  const fraction = running ? overallProgress(running) : -1;
  // Dock / hlavní panel Windows ukazuje průběh i se schovaným oknem.
  win?.setProgressBar(running ? (fraction < 0 ? 2 : fraction) : -1);
  if (!tray) return;
  const waiting = [...active.values()].filter((j) => j.status === 'queued').length;
  const percent = t('common.percent', { percent: Math.round(fraction * 100) });
  const stage = running && t(STAGE_LABEL[running.progress?.stage ?? 'prepare']);
  const label = running
    ? fraction >= 0
      ? t('tray.runningPercent', { stage: stage!, name: running.name, percent })
      : t('tray.running', { stage: stage!, name: running.name })
    : t('tray.idle');
  if (isMac) tray.setTitle(running && fraction >= 0 ? percent : '');
  tray.setToolTip(`TransLatte – ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      ...(waiting ? [{ label: t('tray.waiting', { count: waiting }), enabled: false }] : []),
      { type: 'separator' },
      { label: t('tray.open'), click: showWindow },
      { label: t('tray.quit'), click: () => app.quit() },
    ]),
  );
}

function createTray() {
  const icon = isMac
    ? nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(__dirname, 'tray-win.png'));
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (!isMac) tray.on('click', showWindow);
  updateProgressUi();
}

function setMenu() {
  const template: MenuItemConstructorOptions[] = [];
  if (isMac) template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  if (!app.isPackaged) template.push({ label: t('menu.dev'), submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyTheme(theme: Settings['theme']) {
  nativeTheme.themeSource = theme === 'mono' ? 'light' : theme;
  if (!isMac && win) win.setTitleBarOverlay({ ...TITLE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'], height: 36 });
}

function applyLang(uiLang: Settings['uiLang']) {
  setLang(resolveLang(uiLang, app.getLocale()));
  setMenu();
  updateProgressUi();
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: 'TransLatte',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17130f' : '#f3ede6',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { ...TITLE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'], height: 36 } }),
    autoHideMenuBar: !isMac,
    ...(isMac ? {} : { icon: path.join(__dirname, 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Během překladu zavření okna aplikaci neukončí, překlad doběhne na pozadí (ikona v liště).
  win.on('close', (e) => {
    if (!quitting && (queue.busy || isMac)) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = undefined));
  win.loadFile(path.join(__dirname, 'index.html'));
}

function jobFile(job: Job, kind: OutputKind = 'docx') {
  const name = kind === 'pdf' ? job.outputPdf : job.output;
  return name ? path.join(store.jobDir(job.id), name) : null;
}

function registerIpc() {
  ipcMain.handle('settings', () => store.settings());
  ipcMain.handle('settings-save', async (_e, settings: Settings) => {
    await store.saveSettings(settings);
    applyTheme(settings.theme);
    applyLang(settings.uiLang);
  });
  ipcMain.handle('glossary', () => store.glossary());
  ipcMain.handle('glossary-save', (_e, entries: GlossaryEntry[]) => store.saveGlossary(entries));
  ipcMain.handle('lm-status', async (_e, provider?: Provider) => {
    const s = await store.settings();
    return isOnline({ provider: provider ?? s.provider }) ? openrouterStatus(s.remoteModels, await readKey(store.root)) : status(s.apiUrl, s.models);
  });
  ipcMain.handle('catalog-refresh', () => refreshCatalog());
  // Klíč se do okna nikdy nevrací, jen informace, zda existuje.
  ipcMain.handle('api-key-has', async () => Boolean(await readKey(store.root)));
  ipcMain.handle('api-key-set', (_e, key: string) => saveKey(store.root, key));
  ipcMain.handle('api-key-clear', () => clearKey(store.root));
  ipcMain.handle('pick-files', async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dialog.documents'), extensions: SUPPORTED.map((e) => e.slice(1)) }],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('file-info', (_e, paths: string[]) => fileInfo(paths));
  ipcMain.handle('usd-czk', () => usdCzk(store));
  ipcMain.handle('jobs-add', async (_e, paths: string[], options: JobOptions) => {
    const errors: string[] = [];
    for (const p of paths) {
      try {
        await queue.add(p, options);
      } catch (e) {
        errors.push(`${path.basename(p)}: ${(e as Error).message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
  });
  ipcMain.handle('jobs', () => store.jobs());
  ipcMain.handle('job', async (_e, id: string) => {
    const job = active.get(id) ?? (await store.job(id));
    return job ? { job, segments: await store.segments(id) } : null;
  });
  ipcMain.handle('job-input', async (_e, id: string) => {
    const job = await store.job(id);
    return job ? new Uint8Array(await readFile(store.inputPath(job))) : null;
  });
  ipcMain.handle('job-figure', async (_e, id: string, file: string) => {
    if (!/^figures\/[\w.-]+\.png$/.test(file) || file.includes('..')) throw new Error('Neplatný soubor');
    const job = await store.job(id);
    if (!job) throw new Error('Úloha neexistuje');
    return `data:image/png;base64,${(await readFile(path.join(store.jobDir(job.id), file))).toString('base64')}`;
  });
  ipcMain.handle('job-output-pdf', async (_e, id: string) => {
    const job = await store.job(id);
    const file = job && jobFile(job, 'pdf');
    return file ? new Uint8Array(await readFile(file)) : null;
  });
  ipcMain.handle('job-cancel', (_e, id: string) => queue.cancel(id));
  ipcMain.handle('job-retry', (_e, id: string, mode: Mode) => queue.retry(id, mode));
  ipcMain.handle('job-relayout', async (_e, id: string) => {
    if (active.has(id)) return;
    const job = await store.job(id);
    if (!job) return;
    await relayoutJob(store, job, await store.settings());
    send('job-update', job);
  });
  ipcMain.handle('job-translate-segments', (_e, id: string, ids: number[]) => queue.translateSegments(id, ids));
  ipcMain.handle('job-regions', (_e, id: string) => store.regions(id));
  ipcMain.handle('job-translate-region', async (_e, id: string, page: number, crop: RegionTranslation['crop']) => {
    const job = await store.job(id);
    if (!job) throw new Error(t('study.noJob'));
    const saved = findRegion(await store.regions(id), page, normalizeCrop(crop));
    if (saved) return saved;
    const region = await queue.exclusive(async () => translateRegion(store, job, await store.settings(), page, crop));
    send('job-update', job);
    return region;
  });
  ipcMain.handle('job-delete', async (_e, id: string) => {
    await queue.remove(id);
    send('job-removed', id);
  });
  ipcMain.handle('job-open', async (_e, id: string, kind?: OutputKind) => {
    const job = await store.job(id);
    const file = job && jobFile(job, kind);
    if (file) await shell.openPath(file);
  });
  ipcMain.handle('job-reveal', async (_e, id: string) => {
    const job = await store.job(id);
    const file = job && jobFile(job);
    if (file) shell.showItemInFolder(file);
  });
  ipcMain.handle('job-save-as', async (_e, id: string) => {
    const job = await store.job(id);
    const file = job && jobFile(job);
    if (!file) return;
    const pdf = jobFile(job, 'pdf');
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), job.output!),
      filters: [{ name: 'Word', extensions: ['docx'] }, ...(pdf ? [{ name: 'PDF', extensions: ['pdf'] }] : [])],
    });
    if (res.canceled || !res.filePath) return;
    // Typ se pozná podle přípony, kterou dialog doplní podle zvoleného filtru.
    await copyFile(pdf && path.extname(res.filePath).toLowerCase() === '.pdf' ? pdf : file, res.filePath);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => (quitting = true));
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    if (!isMac && !queue.busy) app.quit();
  });
  app.whenReady().then(async () => {
    app.setName('TransLatte');
    if (isMac) app.dock?.setIcon(path.join(__dirname, 'icon.png'));
    const settings = await store.settings();
    setLang(resolveLang(settings.uiLang, app.getLocale()));
    setMenu();
    registerIpc();
    await queue.recover();
    applyTheme(settings.theme);
    createWindow();
    createTray();
  });
}
