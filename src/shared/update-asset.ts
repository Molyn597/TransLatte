import type { UpdateAsset } from './types';

export const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Molyn597/TransLatte/releases/download/';

/** Instalační soubor vydání pro platformu: mac → universal .dmg, Windows → .exe podle architektury. */
export function pickAsset(assets: UpdateAsset[], platform: string, arch: string): UpdateAsset | null {
  const suffix = platform === 'darwin' ? '-mac-universal.dmg' : platform === 'win32' ? `-win-${arch === 'arm64' ? 'arm64' : 'x64'}.exe` : null;
  if (!suffix) return null;
  return assets.find((a) => a.name.endsWith(suffix) && a.url.startsWith(RELEASE_DOWNLOAD_PREFIX)) ?? null;
}
