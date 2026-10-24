/**
 * Surfshark account session: device identity, token renewal, and WireGuard-key lifecycle.
 *
 * A proxy-farm Surfshark "account" (dynamic path) is: a stable device fingerprint, a
 * self-generated WireGuard key pair, and the `renewalToken` from a one-time login. From the
 * renewal token it mints a fresh Bearer token whenever the cached one is near expiry; the
 * password is used once at registration and never stored. The registered public key expires
 * (~1 day), so it is re-registered before expiry.
 *
 * `registerAccount` runs the one-time join (login → derive device → generate + register key)
 * and returns both the durable identity (store in account.meta) and the secrets (WG private
 * key + renewal token). Re-registering reuses the persisted fingerprint, so one machine stays
 * one Surfshark device.
 */
import { generateWgKeyPair } from '../../wg-key';
import { login, registerPublicKey, renewTokens, SsError } from './client';
import { deviceFingerprint } from './fingerprint';
import { SS_KEY_RENEW_BEFORE_MS, SS_TOKEN_RENEW_SKEW_MS } from './constants';
import type { SsFetch } from './types';

/** The default interface address the app uses for a generated key (no API field carries one). */
export const DEFAULT_SURFSHARK_ADDRESS = '10.14.0.2/16';

/** Durable, non-secret identity (safe for plaintext account.meta). Neither the WG private key
 * nor the renewal token is here — both live in the encrypted secret store. */
export interface AccountIdentity {
  deviceFingerprint: string; // 64-hex, stable per machine; also the x-device-id
  /** The registered WireGuard PUBLIC key (not a secret; identifies the key to the server). */
  publicKey: string;
  /** Epoch ms the key registration expires; re-register before it. */
  keyExpiresAtMs: number;
  /** Interface CIDR for the WireGuard config. */
  address: string;
}

export interface RegisteredAccount {
  identity: AccountIdentity;
  /** WireGuard private key (base64). The account's `wgkey` secret — paired with `renewalToken`. */
  privateKey: string;
  /** Long-lived renewal token. Stored in the encrypted secret, used to mint Bearer tokens. */
  renewalToken: string;
  /** The access token minted during registration (reusable until it expires). */
  accessToken: string;
}

export interface RegisterOptions {
  /** Reuse a persisted fingerprint (re-add) so no new device/key slot is spent needlessly. */
  deviceFingerprint?: string;
  now?: () => number;
}

/** The `exp` (epoch seconds) of a JWT, or undefined if it has none/garbled. */
export function jwtExpSeconds(token: string): number | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** Run the one-time join and return the identity + secrets. */
export async function registerAccount(
  creds: { username: string; password: string },
  net: SsFetch,
  opts: RegisterOptions = {},
): Promise<RegisteredAccount> {
  const fingerprint = deviceFingerprint(opts.deviceFingerprint);
  const tokens = await login({ username: creds.username, password: creds.password, deviceId: fingerprint }, net);
  const pair = generateWgKeyPair();
  const registered = await registerPublicKey(
    { pubKey: pair.publicKey, deviceId: fingerprint, token: tokens.authenticationToken },
    net,
  );
  return {
    identity: {
      deviceFingerprint: fingerprint,
      publicKey: registered.publicKey,
      keyExpiresAtMs: registered.expiresAtMs,
      address: DEFAULT_SURFSHARK_ADDRESS,
    },
    privateKey: pair.privateKey,
    renewalToken: tokens.renewalToken,
    accessToken: tokens.authenticationToken,
  };
}

/** Mints a fresh Bearer token from the renewal token, caching it until near its JWT expiry. */
export interface TokenMinter {
  getToken(): Promise<string>;
  /** The renewal token in use (it may rotate on renew); callers persist the latest. */
  renewalToken(): string;
}

export function createTokenMinter(
  args: { renewalToken: string; deviceId: string; seedToken?: string },
  net: SsFetch,
  opts: { now?: () => number } = {},
): TokenMinter {
  const now = opts.now ?? Date.now;
  let renewal = args.renewalToken;
  let token = args.seedToken;
  let expSec = token ? jwtExpSeconds(token) : undefined;
  let inflight: Promise<string> | undefined;

  const fresh = () => token !== undefined && expSec !== undefined && now() / 1000 < expSec - SS_TOKEN_RENEW_SKEW_MS / 1000;

  return {
    renewalToken: () => renewal,
    async getToken() {
      if (fresh()) return token!;
      inflight ??= (async () => {
        const next = await renewTokens({ renewalToken: renewal, deviceId: args.deviceId }, net);
        renewal = next.renewalToken;
        token = next.authenticationToken;
        expSec = jwtExpSeconds(token);
        return token;
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

/** Re-register the WireGuard public key if its registration is within the renew window.
 * Returns the fresh identity when it changed, else undefined. */
export async function ensureKeyFresh(
  args: { identity: AccountIdentity; minter: TokenMinter },
  net: SsFetch,
  opts: { now?: () => number } = {},
): Promise<AccountIdentity | undefined> {
  const now = opts.now ?? Date.now;
  if (args.identity.keyExpiresAtMs - now() >= SS_KEY_RENEW_BEFORE_MS) return undefined;
  const token = await args.minter.getToken();
  const registered = await registerPublicKey(
    { pubKey: args.identity.publicKey, deviceId: args.identity.deviceFingerprint, token },
    net,
  );
  return { ...args.identity, keyExpiresAtMs: registered.expiresAtMs };
}

/** Map a provider error to the i18n key the UI shows. */
export function ssErrorKey(err: unknown): string {
  if (err instanceof SsError) {
    if (err.kind === 'network') return 'surfshark.account.network';
    if (err.kind === 'invalidCredentials') return 'surfshark.account.invalidCredentials';
    if (err.kind === 'twoFactorRequired') return 'surfshark.account.twoFactorRequired';
    if (err.kind === 'unauthorized') return 'surfshark.account.unauthorized';
  }
  return 'surfshark.account.failed';
}

/** Pack/unpack the identity into the flat string map `account.meta` is. */
export function identityToMeta(id: AccountIdentity): Record<string, string> {
  return {
    source: 'account',
    deviceFingerprint: id.deviceFingerprint,
    publicKey: id.publicKey,
    keyExpiresAt: String(id.keyExpiresAtMs),
    address: id.address,
  };
}

export function identityFromMeta(meta: Record<string, string>): AccountIdentity | undefined {
  if (meta.source !== 'account') return undefined;
  const { deviceFingerprint: fp, publicKey, keyExpiresAt, address } = meta;
  const expMs = Number(keyExpiresAt);
  if (!fp || !publicKey || !Number.isFinite(expMs) || !address) return undefined;
  return { deviceFingerprint: fp, publicKey, keyExpiresAtMs: expMs, address };
}
