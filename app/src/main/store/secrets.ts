import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The subset of Electron's `safeStorage` module this store needs. Real main-process
 * code injects `electron.safeStorage`; tests inject a fake (see secrets.test.ts).
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStore {
  saveSecret(id: string, plaintext: string): void;
  loadSecret(id: string): string | null;
  deleteSecret(id: string): void;
}

/** `id` can be any string (e.g. an account id); this maps it to a safe file name. */
function fileNameFor(id: string): string {
  const hex = Buffer.from(id, 'utf8').toString('hex');
  return `${hex}.bin`;
}

/**
 * Wraps `safeStorage` to persist one ciphertext file per secret id under `dir`.
 * Never stores or logs plaintext; `dir` is created on first write.
 */
export function createSecretStore(safeStorage: SafeStorageLike, dir: string): SecretStore {
  function pathFor(id: string): string {
    return join(dir, fileNameFor(id));
  }

  return {
    saveSecret(id, plaintext) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('safeStorage encryption is not available on this platform');
      }
      mkdirSync(dir, { recursive: true });
      const encrypted = safeStorage.encryptString(plaintext);
      writeFileSync(pathFor(id), encrypted);
    },

    loadSecret(id) {
      try {
        const encrypted = readFileSync(pathFor(id));
        return safeStorage.decryptString(encrypted);
      } catch {
        return null;
      }
    },

    deleteSecret(id) {
      try {
        unlinkSync(pathFor(id));
      } catch {
        // already gone — deleting is idempotent
      }
    },
  };
}
