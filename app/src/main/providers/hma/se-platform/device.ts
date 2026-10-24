/**
 * Device identity + token management for the se-platform path.
 *
 * A proxy-farm "device" under an HMA license is just: a wallet key (the license), a stable
 * `deviceFingerprint`, and the `tenant`/`containerId`/`deviceUdid` the backend returns.
 * Tokens are kept fresh the way the app does it (decompiled from VpnSvc): the 12 h elysium
 * JWT is renewed with its single-use refresh token (`elysium/v1/renew`), and only when that
 * is refused does it fall back to re-associating the license (idempotent per fingerprint).
 * The access token lives in memory only; the refresh token is handed to the caller to keep
 * in the encrypted secret, as the app keeps it in its secure storage.
 *
 * `registerDevice` runs the one-time join (license → associate → passage credentials) and
 * returns both the durable identity (store in account.meta) and the OpenVPN
 * username/password (store as the account's `userpass` secret). Re-registering the SAME
 * fingerprint returns the same device, so it never burns extra license device slots.
 */
import { randomBytes } from 'node:crypto';
import { associateLicense, fetchDeviceCredentials, fetchLicense, renewToken, SeError, tenantOfUdid } from './client';
import { HMA_TENANT_ID } from './constants';
import { jwtExpSeconds } from './jwt';
import { machineFingerprint } from './fingerprint';
import type { SeDeviceToken, SeFetch, SeTokens } from './types';

/** The durable, non-secret part of a registered device (safe for plaintext account.meta).
 * The `walletKey` (license) is a credential and is NOT here — it lives in the encrypted
 * secret store and is passed to the minter separately. */
export interface DeviceIdentity {
  deviceFingerprint: string; // 64-hex (a hash of a machine id; not a credential on its own)
  tenant: string; // GUID
  containerId: string; // derived from the license; useless without the walletKey
  deviceUdid: string;
  /** PEM CA that signs the OpenVPN server cert, for sing-box `tls.certificate`. */
  openvpnCaCertificate: string;
  /** Epoch ms the OpenVPN password + CA were fetched from passage. The app trusts them for
   * `DEVICE_CREDENTIALS_VALIDITY_MS` and then fetches new ones. Unknown for accounts
   * registered before this was tracked (treated as due). */
  credentialsAt?: number;
}

export interface RegisteredDevice {
  identity: DeviceIdentity;
  /** OpenVPN username = deviceUdid. */
  username: string;
  /** OpenVPN password (64-hex). The account's `userpass` secret. */
  password: string;
  /** The token pair minted during registration (the access token is reusable until it
   * expires; the refresh token belongs in the encrypted secret). */
  accessToken: string;
  refreshToken: string;
}

export interface RegisterOptions {
  /** Reuse an existing fingerprint/tenant (e.g. to re-register after creds were lost)
   * instead of minting a new device. */
  deviceFingerprint?: string;
  tenant?: string;
  now?: () => number; // epoch ms
}

/** A fresh 64-hex device fingerprint (sha256-shaped; the backend only needs it stable). */
export function newDeviceFingerprint(): string {
  return randomBytes(32).toString('hex');
}

/** Run the one-time device join and return its identity + OpenVPN credentials. */
export async function registerDevice(walletKey: string, net: SeFetch, opts: RegisterOptions = {}): Promise<RegisteredDevice> {
  // Prefer a persisted fingerprint (re-add of this account), then a stable machine-derived
  // one (so this machine is always the same single device), then a random fallback.
  const deviceFingerprint = opts.deviceFingerprint || machineFingerprint() || newDeviceFingerprint();
  let tenant = opts.tenant ?? HMA_TENANT_ID;
  const now = opts.now ?? Date.now;

  const license = await fetchLicense(walletKey, deviceFingerprint, net);
  const token = await associateLicense(
    { containerId: license.id, deviceFingerprint, walletKey, tenantId: tenant },
    net,
  );
  // Trust the tenant the backend actually bound the device under (it echoes it in the udid).
  tenant = tenantOfUdid(token.deviceUdid) ?? tenant;

  const creds = await fetchDeviceCredentials({ deviceUdid: token.deviceUdid, tenantId: tenant, token: token.accessToken }, net);

  return {
    identity: {
      deviceFingerprint,
      tenant,
      containerId: license.id,
      deviceUdid: token.deviceUdid,
      openvpnCaCertificate: creds.openvpnCaCertificate,
      credentialsAt: now(),
    },
    username: token.deviceUdid,
    password: creds.devicePassword,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
  };
}

/** Keeps a device's elysium JWT fresh. */
export interface TokenMinter {
  getToken(): Promise<string>;
  /** Drop the cached access token because the API rejected it; the next `getToken`
   * renews (or re-associates) instead of handing the same token out again. */
  invalidate(): void;
  /** The current refresh token, if any (to keep in the encrypted secret). */
  refreshToken(): string | undefined;
}

export interface TokenMinterOptions {
  now?: () => number;
  /** An access token already in hand (e.g. from registration). */
  seedToken?: string;
  /** The stored refresh token; renewal starts from it instead of re-associating. */
  refreshToken?: string;
  /** Called with every new refresh token (each renew spends the previous one). */
  onRefreshToken?: (refreshToken: string) => void;
  /** associate-license bound this license to a DIFFERENT device than the stored one (the
   * old device was removed from the license). The minter adopts the new udid; the caller
   * must fetch that device's credentials and store them. */
  onDeviceChanged?: (minted: SeDeviceToken) => void;
}

/** How early (seconds) to renew before the real `exp`. The app renews only within 15 s of
 * expiry, on its next call; a few minutes leaves room for a slow request. */
const REFRESH_SKEW_SEC = 5 * 60;

/** A renew failure that means the refresh token (or device) is no longer usable — as opposed
 * to an outage, after which re-associating would fail too. */
function renewRefused(err: unknown): boolean {
  if (!(err instanceof SeError)) return false;
  if (err.kind === 'network') return false;
  if (err.kind === 'http') return (err.status ?? 500) < 500;
  return true; // unauthorized, gone, badResponse
}

export function createTokenMinter(
  identity: Pick<DeviceIdentity, 'deviceFingerprint' | 'tenant' | 'containerId' | 'deviceUdid'>,
  walletKey: string,
  net: SeFetch,
  opts: TokenMinterOptions = {},
): TokenMinter {
  const now = opts.now ?? Date.now;
  let deviceUdid = identity.deviceUdid;
  let token = opts.seedToken;
  let expSec = token ? jwtExpSeconds(token) : undefined;
  let refresh = opts.refreshToken;
  let inflight: Promise<string> | undefined;

  const fresh = () => token !== undefined && expSec !== undefined && now() / 1000 < expSec - REFRESH_SKEW_SEC;

  function adopt(tokens: SeTokens): string {
    token = tokens.accessToken;
    expSec = jwtExpSeconds(token);
    if (tokens.refreshToken !== refresh) {
      refresh = tokens.refreshToken;
      opts.onRefreshToken?.(refresh);
    }
    return token;
  }

  async function mint(): Promise<string> {
    if (refresh) {
      try {
        return adopt(await renewToken({ deviceUdid, refreshToken: refresh, tenantId: identity.tenant }, net));
      } catch (err) {
        if (!renewRefused(err)) throw err;
        refresh = undefined; // spent or revoked: re-associate below
      }
    }
    const minted = await associateLicense(
      { containerId: identity.containerId, deviceFingerprint: identity.deviceFingerprint, walletKey, tenantId: identity.tenant },
      net,
    );
    if (minted.deviceUdid !== deviceUdid) {
      deviceUdid = minted.deviceUdid;
      opts.onDeviceChanged?.(minted);
    }
    return adopt(minted);
  }

  return {
    async getToken() {
      if (fresh()) return token!;
      inflight ??= mint().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      token = undefined;
      expSec = undefined;
    },
    refreshToken: () => refresh,
  };
}

/** Runs `fn` with the device's token; when the API rejects that token (401/403) it drops it
 * and retries once with a newly minted one, so a revoked token never stalls the caller until
 * its natural expiry. */
export async function withToken<T>(minter: TokenMinter, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await minter.getToken();
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof SeError) || err.kind !== 'unauthorized') throw err;
    minter.invalidate();
    return fn(await minter.getToken());
  }
}

/** Whether a device's passage credentials are past the app's 7-day validity (or of unknown
 * age, for accounts registered before it was tracked). */
export function credentialsDue(identity: Pick<DeviceIdentity, 'credentialsAt'>, nowMs: number, validityMs: number): boolean {
  return identity.credentialsAt === undefined || nowMs - identity.credentialsAt >= validityMs;
}

/** Pack/unpack a DeviceIdentity into the flat string map `account.meta` is (spec: meta is
 * non-secret). The password lives in the encrypted secret, never here. */
export function identityToMeta(id: DeviceIdentity): Record<string, string> {
  return {
    source: 'se-platform',
    deviceFingerprint: id.deviceFingerprint,
    tenant: id.tenant,
    containerId: id.containerId,
    deviceUdid: id.deviceUdid,
    openvpnCa: id.openvpnCaCertificate,
    ...(id.credentialsAt !== undefined ? { credsAt: String(id.credentialsAt) } : {}),
  };
}

export function identityFromMeta(meta: Record<string, string>): DeviceIdentity | undefined {
  if (meta.source !== 'se-platform') return undefined;
  const { deviceFingerprint, tenant, containerId, deviceUdid, openvpnCa } = meta;
  if (!deviceFingerprint || !tenant || !containerId || !deviceUdid || !openvpnCa) return undefined;
  const credsAt = Number(meta.credsAt);
  return {
    deviceFingerprint,
    tenant,
    containerId,
    deviceUdid,
    openvpnCaCertificate: openvpnCa,
    ...(meta.credsAt && Number.isFinite(credsAt) ? { credentialsAt: credsAt } : {}),
  };
}

/** A masked, non-secret hint of a license key for the UI (never the full key). */
export function licenseHint(walletKey: string): string {
  const tail = walletKey.slice(-4);
  return tail ? `••••-${tail}` : '';
}
