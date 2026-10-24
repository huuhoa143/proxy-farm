/**
 * WireGuard key helpers shared by the key-based providers (Surfshark, NordVPN).
 *
 * An account is labelled after its PUBLIC key: the private key is a secret and nothing
 * derived from it reaches the UI, the state file or the logs. The public key's tail is
 * also what the user can match against the provider's dashboard (Surfshark lists the
 * public keys of the key pairs it generated).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

/** DER prefix of a PKCS#8 X25519 private key; the 32 raw key bytes follow it. */
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/**
 * A fresh WireGuard key pair, both keys base64 as WireGuard writes them. The private key is
 * the 32 raw scalar bytes of a new X25519 key (OpenSSL already stores it clamped); the
 * public key is derived the same way `wgPublicKey` does, so the two always match.
 */
export function generateWgKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('x25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  // PKCS#8 X25519 is the 16-byte prefix above followed by the 32 raw key bytes.
  const raw = pkcs8.subarray(pkcs8.length - 32);
  const privB64 = raw.toString('base64');
  return { privateKey: privB64, publicKey: wgPublicKey(privB64) };
}

/** The X25519 public key (base64) of a base64 WireGuard private key. Throws on a key
 * that is not 32 bytes. */
export function wgPublicKey(privateKey: string): string {
  const raw = Buffer.from(privateKey, 'base64');
  if (raw.length !== 32) throw new Error('wgPublicKey: a WireGuard private key is 32 bytes');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Stored account label of a key-based account: `pubkey …<last 6 of the public key>`
 * (the renderer localises the template, `ui/accountLabel.ts`). */
export function wgKeyLabel(privateKey: string): string {
  return `pubkey …${wgPublicKey(privateKey).replace(/=+$/, '').slice(-6)}`;
}

/** The label template of earlier builds, made from the PRIVATE key's last 6 characters. */
export const LEGACY_KEY_LABEL_RE = /^key …\S+$/;

/** The legacy label earlier builds stored for this private key. Only used to find such an
 * account again when its key is re-added; never stored. */
export function legacyKeyLabel(privateKey: string): string {
  return `key …${privateKey.slice(-6)}`;
}

/** The account's `wgkey` secret, or undefined when it is missing or another kind. */
function wgPrivateKeyOf(secretJson: string | null): string | undefined {
  if (!secretJson) return undefined;
  try {
    const secret = JSON.parse(secretJson) as { kind?: unknown; privateKey?: unknown };
    return secret.kind === 'wgkey' && typeof secret.privateKey === 'string' ? secret.privateKey : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Relabels accounts saved with the legacy private-key label after their public key.
 * Accounts whose key cannot be read (secrets lost with an unavailable keychain) keep
 * the legacy label; the renderer never shows its suffix. Returns the same array when
 * nothing changed.
 */
export function migrateKeyLabels<A extends { label: string; secretRef: string }>(
  accounts: A[],
  loadSecret: (secretRef: string) => string | null,
): A[] {
  let changed = false;
  const next = accounts.map((account) => {
    if (!LEGACY_KEY_LABEL_RE.test(account.label)) return account;
    const privateKey = wgPrivateKeyOf(loadSecret(account.secretRef));
    if (!privateKey) return account;
    let label: string;
    try {
      label = wgKeyLabel(privateKey);
    } catch {
      return account;
    }
    changed = true;
    return { ...account, label };
  });
  return changed ? next : accounts;
}
