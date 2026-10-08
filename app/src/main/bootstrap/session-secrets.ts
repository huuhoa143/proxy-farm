import { createSecretStore, type SafeStorageLike, type SecretStore } from '../store/secrets';

export interface SessionSecretStore extends SecretStore {
  /** True when `safeStorage` can't encrypt on this machine/session: every secret saved
   * from here on lives in memory only and is lost on quit (surfaced to the UI). */
  readonly unavailable: boolean;
}

/**
 * The on-disk `safeStorage` secret store, with an in-memory fallback for when
 * `safeStorage.isEncryptionAvailable()` is false (e.g. Linux without a keyring, or a
 * locked/denied macOS keychain). Plaintext secrets are NEVER written to disk in that
 * case; they stay in this process's memory for the session, and `unavailable` lets the
 * composition root show a persistent warning. Reads fall back to disk so secrets saved
 * in an earlier, healthy session still decrypt if decryption works.
 */
export function createSessionSecretStore(safeStorage: SafeStorageLike, dir: string): SessionSecretStore {
  const disk = createSecretStore(safeStorage, dir);
  const memory = new Map<string, string>();
  let unavailable = !safeStorage.isEncryptionAvailable();

  return {
    get unavailable() {
      return unavailable;
    },
    saveSecret(id, plaintext) {
      if (!unavailable) {
        try {
          disk.saveSecret(id, plaintext);
          memory.delete(id);
          return;
        } catch {
          unavailable = true;
        }
      }
      memory.set(id, plaintext);
    },
    loadSecret(id) {
      return memory.get(id) ?? disk.loadSecret(id);
    },
    deleteSecret(id) {
      memory.delete(id);
      disk.deleteSecret(id);
    },
  };
}
