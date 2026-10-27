import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import { t } from '../shared/i18n';

/** API klíč OpenRouter šifrovaný systémovým úložištěm (Keychain, DPAPI); v settings.json ani v okně není. */
const keyFile = (root: string) => path.join(root, 'openrouter.key');

export const clearKey = (root: string) => rm(keyFile(root), { force: true });

export async function saveKey(root: string, key: string) {
  const trimmed = key.trim();
  if (!trimmed) return clearKey(root);
  if (!safeStorage.isEncryptionAvailable()) throw new Error(t('openrouter.noEncryption'));
  await mkdir(root, { recursive: true });
  await writeFile(keyFile(root), safeStorage.encryptString(trimmed), { mode: 0o600 });
  await chmod(keyFile(root), 0o600);
}

export async function readKey(root: string): Promise<string | undefined> {
  try {
    return safeStorage.decryptString(await readFile(keyFile(root))) || undefined;
  } catch {
    return undefined;
  }
}
