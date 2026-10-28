import { app } from 'electron';
import { isNewer } from '../shared/version';
import type { Store } from './store';
import type { UpdateCheck } from '../shared/types';

const RELEASE_URL = 'https://api.github.com/repos/Molyn597/TransLatte/releases/latest';
const DAY = 24 * 3600 * 1000;

/** Poslední vydání na GitHubu; při jakékoli chybě (i 404 u soukromého repozitáře) null. */
export async function latestRelease(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TransLatte' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!json.tag_name || !json.html_url) return null;
    return { version: json.tag_name.replace(/^v/i, ''), url: json.html_url };
  } catch {
    return null;
  }
}

/** Automatická kontrola běží nejvýš jednou denně, ruční vždy. */
export async function checkUpdate(store: Store, auto: boolean): Promise<UpdateCheck> {
  const current = app.getVersion();
  const settings = await store.settings();
  if (auto && settings.lastUpdateCheck && Date.now() - settings.lastUpdateCheck < DAY) return { current, newer: false, ok: false };
  const latest = await latestRelease();
  if (latest) await store.saveSettings({ ...(await store.settings()), lastUpdateCheck: Date.now() });
  return { current, ...(latest ? { latest } : {}), newer: latest ? isNewer(latest.version, current) : false, ok: latest !== null };
}
