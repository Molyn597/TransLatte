import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, shell } from 'electron';
import { isNewer } from '../shared/version';
import { pickAsset } from '../shared/update-asset';
import type { Store } from './store';
import type { UpdateAsset, UpdateCheck, UpdateResult } from '../shared/types';

const RELEASE_URL = 'https://api.github.com/repos/Molyn597/TransLatte/releases/latest';
const DAY = 24 * 3600 * 1000;
const NOTES_MAX = 1500;

interface Release {
  version: string;
  url: string;
  notes: string;
  assets: UpdateAsset[];
}

/** Poslední vydání na GitHubu; při jakékoli chybě (i 404 u soukromého repozitáře) null. */
export async function latestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TransLatte' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      assets?: { name?: string; browser_download_url?: string; size?: number }[];
    };
    if (!json.tag_name || !json.html_url) return null;
    const body = (json.body ?? '').trim();
    return {
      version: json.tag_name.replace(/^v/i, ''),
      url: json.html_url,
      notes: body.length > NOTES_MAX ? `${body.slice(0, NOTES_MAX).trimEnd()}…` : body,
      assets: (json.assets ?? []).flatMap((a) => (a.name && a.browser_download_url ? [{ name: a.name, url: a.browser_download_url, size: a.size ?? 0 }] : [])),
    };
  } catch {
    return null;
  }
}

/** Automatická kontrola běží nejvýš jednou denně, ruční vždy. */
export async function checkUpdate(store: Store, auto: boolean): Promise<UpdateCheck> {
  const current = app.getVersion();
  const settings = await store.settings();
  if (auto && settings.lastUpdateCheck && Date.now() - settings.lastUpdateCheck < DAY) return { current, newer: false, ok: false };
  const release = await latestRelease();
  if (release) await store.saveSettings({ ...(await store.settings()), lastUpdateCheck: Date.now() });
  const latest = release ? { version: release.version, url: release.url, notes: release.notes } : undefined;
  return { current, ...(latest ? { latest } : {}), newer: release ? isNewer(release.version, current) : false, ok: release !== null };
}

/**
 * Stáhne instalátor do Stažených a spustí ho. Windows: NSIS (oneClick) aplikaci nainstaluje a spustí znovu,
 * proto se po spuštění ukončí. macOS: otevře se DMG, nepodepsanou aplikaci za běhu nahradit nejde.
 */
export async function downloadUpdate(onProgress: (received: number, total: number) => void): Promise<UpdateResult> {
  const release = await latestRelease();
  if (!release) return { ok: false, error: 'release' };
  const asset = pickAsset(release.assets, process.platform, process.arch);
  if (!asset) return { ok: false, error: 'asset', url: release.url };
  const target = path.join(app.getPath('downloads'), path.basename(asset.name));
  const part = `${target}.part`;
  try {
    const res = await fetch(asset.url, { headers: { 'User-Agent': 'TransLatte' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || asset.size;
    let received = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (Date.now() - last > 150) {
        last = Date.now();
        onProgress(received, total);
      }
    });
    await pipeline(body, createWriteStream(part));
    onProgress(received, total);
    await rename(part, target);
    const failed = await shell.openPath(target);
    if (failed) return { ok: false, error: failed, url: release.url };
  } catch (e) {
    await rm(part, { force: true });
    return { ok: false, error: (e as Error).message, url: release.url };
  }
  if (process.platform === 'win32') {
    setTimeout(() => app.quit(), 1500);
    return { ok: true, platform: 'windows' };
  }
  return { ok: true, platform: 'mac' };
}
