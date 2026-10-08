/**
 * Parse HMA's `tokenCoreSE.json` device-credentials blob (spec §5.1).
 *
 * On macOS the file lives at
 * `/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json`, is
 * world-readable, and its top-level JSON has one key of interest,
 * `DeviceManager.device`, whose value is base64 of an inner JSON object:
 *
 *   { "udid": "U1....", "credentials": { "password": "<64 hex>", ... }, ... }
 *
 * Reading the file itself is the controller's job (it owns filesystem
 * access and the file-watch that re-parses on change); this module only
 * does the parsing, so it can be unit-tested with a fixture and reused from
 * wherever the Windows `auth` file eventually lands (see TODO in index.ts).
 */

export interface DeviceCreds {
  udid: string;
  password: string;
}

const DEVICE_KEY = 'DeviceManager.device';

export function parseDeviceCreds(fileText: string): DeviceCreds {
  let outer: unknown;
  try {
    outer = JSON.parse(fileText);
  } catch {
    throw new Error('hma: tokenCoreSE.json is not valid JSON');
  }

  if (typeof outer !== 'object' || outer === null || !(DEVICE_KEY in outer)) {
    throw new Error(`hma: tokenCoreSE.json is missing the "${DEVICE_KEY}" key`);
  }

  const raw = (outer as Record<string, unknown>)[DEVICE_KEY];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`hma: "${DEVICE_KEY}" is not a non-empty string`);
  }

  let inner: unknown;
  try {
    inner = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error(`hma: "${DEVICE_KEY}" did not decode to valid JSON`);
  }

  if (typeof inner !== 'object' || inner === null) {
    throw new Error('hma: decoded device blob is not an object');
  }

  const udid = (inner as Record<string, unknown>).udid;
  if (typeof udid !== 'string' || udid.length === 0) {
    throw new Error('hma: decoded device blob is missing udid');
  }

  const credentials = (inner as Record<string, unknown>).credentials;
  const password =
    typeof credentials === 'object' && credentials !== null
      ? (credentials as Record<string, unknown>).password
      : undefined;
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hma: decoded device blob is missing credentials.password');
  }

  return { udid, password };
}

/**
 * Parse HMA's Windows OpenVPN credentials file,
 * `%ProgramData%\Privax\HMA VPN\HmaProVpn\auth` (spec §5.1): line 1 the username
 * (`U1.<device id>.hma101.<64 hex>`), line 2 the 64-hex password. Verified 2026-10-09:
 * the pair authenticates exactly like the macOS `udid`/`password`, so it maps onto the
 * same `DeviceCreds` and the provider's `check()` validates it unchanged.
 */
export function parseAuthFile(fileText: string): DeviceCreds {
  const lines = fileText
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const [udid = '', password = ''] = lines;
  if (udid.length === 0) throw new Error('hma: auth file has no username line');
  if (password.length === 0) throw new Error('hma: auth file has no password line');
  return { udid, password };
}
