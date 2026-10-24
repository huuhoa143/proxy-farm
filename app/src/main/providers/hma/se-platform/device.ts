/**
 * Device identity + token management for the se-platform path.
 *
 * A proxy-farm "device" under an HMA license is just: a wallet key (the license), a stable
 * random `deviceFingerprint`, and the `tenant`/`containerId`/`deviceUdid` the backend
 * returns. From those four it can mint a fresh 12 h elysium JWT at any time by re-calling
 * associate-license (idempotent), so the short-lived token is never persisted — only
 * cached in memory and re-minted on expiry.
 *
 * `registerDevice` runs the one-time join (license → associate → passage credentials) and
 * returns both the durable identity (store in account.meta) and the OpenVPN
 * username/password (store as the account's `userpass` secret). Re-registering the SAME
 * fingerprint returns the same device, so it never burns extra license device slots.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { associateLicense, fetchDeviceCredentials, fetchLicense, tenantOfUdid } from './client';
import { jwtExpSeconds } from './jwt';
import { machineFingerprint } from './fingerprint';
import type { SeFetch } from './types';

/** The durable, non-password part of a registered device (safe for account.meta). */
export interface DeviceIdentity {
  walletKey: string;
  deviceFingerprint: string; // 64-hex
  tenant: string; // GUID
  containerId: string;
  deviceUdid: string;
  /** PEM CA that signs the OpenVPN server cert, for sing-box `tls.certificate`. */
  openvpnCaCertificate: string;
}

export interface RegisteredDevice {
  identity: DeviceIdentity;
  /** OpenVPN username = deviceUdid. */
  username: string;
  /** OpenVPN password (64-hex). The account's `userpass` secret. */
  password: string;
  /** The token minted during registration (reusable until it expires). */
  accessToken: string;
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
  let tenant = opts.tenant ?? randomUUID();

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
      walletKey,
      deviceFingerprint,
      tenant,
      containerId: license.id,
      deviceUdid: token.deviceUdid,
      openvpnCaCertificate: creds.openvpnCaCertificate,
    },
    username: token.deviceUdid,
    password: creds.devicePassword,
    accessToken: token.accessToken,
  };
}

/** Re-mints the elysium JWT when the cached one is within `skewSec` of expiry. */
export interface TokenMinter {
  getToken(): Promise<string>;
}

/** How early (seconds) to refresh before the real `exp`. */
const REFRESH_SKEW_SEC = 60 * 60; // 1 h

export function createTokenMinter(
  identity: Pick<DeviceIdentity, 'walletKey' | 'deviceFingerprint' | 'tenant' | 'containerId'>,
  net: SeFetch,
  opts: { now?: () => number; seedToken?: string } = {},
): TokenMinter {
  const now = opts.now ?? Date.now;
  let token = opts.seedToken;
  let expSec = token ? jwtExpSeconds(token) : undefined;
  let inflight: Promise<string> | undefined;

  const fresh = () => token !== undefined && expSec !== undefined && now() / 1000 < expSec - REFRESH_SKEW_SEC;

  return {
    async getToken() {
      if (fresh()) return token!;
      inflight ??= (async () => {
        const minted = await associateLicense(
          { containerId: identity.containerId, deviceFingerprint: identity.deviceFingerprint, walletKey: identity.walletKey, tenantId: identity.tenant },
          net,
        );
        token = minted.accessToken;
        expSec = jwtExpSeconds(token);
        return token;
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

/** Pack/unpack a DeviceIdentity into the flat string map `account.meta` is (spec: meta is
 * non-secret). The password lives in the encrypted secret, never here. */
export function identityToMeta(id: DeviceIdentity): Record<string, string> {
  return {
    source: 'se-platform',
    walletKey: id.walletKey,
    deviceFingerprint: id.deviceFingerprint,
    tenant: id.tenant,
    containerId: id.containerId,
    deviceUdid: id.deviceUdid,
    openvpnCa: id.openvpnCaCertificate,
  };
}

export function identityFromMeta(meta: Record<string, string>): DeviceIdentity | undefined {
  if (meta.source !== 'se-platform') return undefined;
  const { walletKey, deviceFingerprint, tenant, containerId, deviceUdid, openvpnCa } = meta;
  if (!walletKey || !deviceFingerprint || !tenant || !containerId || !deviceUdid || !openvpnCa) return undefined;
  return { walletKey, deviceFingerprint, tenant, containerId, deviceUdid, openvpnCaCertificate: openvpnCa };
}
