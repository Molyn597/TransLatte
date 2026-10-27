import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s.split('').reverse().join('')}`),
    decryptString: (b: Buffer) => b.toString().slice(4).split('').reverse().join(''),
  },
}));

import { clearKey, readKey, saveKey } from '../src/main/keystore';

describe('keystore', () => {
  it('uloží klíč šifrovaně, přečte ho a smaže', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tl-'));
    expect(await readKey(root)).toBeUndefined();
    await saveKey(root, '  sk-or-abc ');
    expect((await readFile(path.join(root, 'openrouter.key'))).toString()).not.toContain('sk-or-abc');
    expect(await readKey(root)).toBe('sk-or-abc');
    await clearKey(root);
    expect(await readKey(root)).toBeUndefined();
  });
});
