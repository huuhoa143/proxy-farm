import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretStore, type SafeStorageLike } from './secrets';

/** A fake safeStorage: reversible, and distinguishable from plaintext so a round-trip
 * test actually proves decrypt(encrypt(x)) === x rather than just the identity. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^enc:/, ''),
  };
}

describe('secrets store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-secrets-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a secret through the injected safeStorage', () => {
    const store = createSecretStore(fakeSafeStorage(), dir);
    store.saveSecret('hma-1', 'super-secret-password');
    expect(store.loadSecret('hma-1')).toBe('super-secret-password');
  });

  it('stores ciphertext on disk, never the plaintext', () => {
    const store = createSecretStore(fakeSafeStorage(), dir);
    store.saveSecret('acct', 'hunter2');
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const raw = readdirSync(dir, { withFileTypes: true })[0];
    const content = readFileSync(join(dir, raw.name), 'utf8');
    expect(content).not.toBe('hunter2');
    expect(content).toBe('enc:hunter2');
  });

  it('returns null for a secret that was never saved', () => {
    const store = createSecretStore(fakeSafeStorage(), dir);
    expect(store.loadSecret('nope')).toBeNull();
  });

  it('deleteSecret removes the file and is idempotent', () => {
    const store = createSecretStore(fakeSafeStorage(), dir);
    store.saveSecret('acct', 'value');
    store.deleteSecret('acct');
    expect(store.loadSecret('acct')).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(() => store.deleteSecret('acct')).not.toThrow();
  });

  it('throws on save when encryption is unavailable', () => {
    const store = createSecretStore(fakeSafeStorage(false), dir);
    expect(() => store.saveSecret('acct', 'value')).toThrow();
  });

  it('different ids never collide on disk', () => {
    const store = createSecretStore(fakeSafeStorage(), dir);
    store.saveSecret('a', 'one');
    store.saveSecret('b', 'two');
    expect(store.loadSecret('a')).toBe('one');
    expect(store.loadSecret('b')).toBe('two');
  });
});
