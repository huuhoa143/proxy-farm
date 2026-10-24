/**
 * se-platform API client (pure request/response, network injected as `SeFetch`).
 *
 * Every function builds exactly the request the HMA Windows app sends (captured live,
 * docs/HMA-SE-PLATFORM.md) and parses only the fields proxy-farm needs. Errors are thrown
 * as `SeError` with a stable `kind` the caller maps to an i18n key; nothing here persists
 * state or touches disk.
 */
import {
  AVAST_APP_BUILD_VERSION,
  AVAST_APP_IPM_PRODUCT,
  AVAST_APP_PRODUCT_BRAND,
  AVAST_APP_PRODUCT_EDITION,
  AVAST_APP_PRODUCT_MODE,
  AVAST_LICENSE_HOST,
  SE_CLIENT_API_KEY,
  SE_CLIENT_NAME,
  SE_CLIENT_TYPE,
  SE_CLIENT_VERSION,
  SE_HOST,
  SE_OS_TYPE,
  SE_OS_VERSION,
  SE_PLATFORM_ID,
  SE_SDK_VERSION,
} from './constants';
import type {
  SeDeviceCredentials,
  SeDeviceToken,
  SeDiscoverResult,
  SeFetch,
  SeGateway,
  SeGeoCountry,
  SeLicense,
  SeProtocol,
  SeResponse,
} from './types';

export type SeErrorKind =
  | 'network' // request never completed (offline, DNS, TLS)
  | 'http' // non-2xx status
  | 'badResponse' // 2xx but the body was not the shape we expect
  | 'noLicense' // the wallet key matched no usable license
  | 'unauthorized'; // 401/403 — token rejected or wrong API key

export class SeError extends Error {
  constructor(
    readonly kind: SeErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SeError';
  }
}

/** The X-NLok-Tenant-ID / device-udid structure: `U1.<tenant>.hma101.<hex>`. */
export function tenantOfUdid(deviceUdid: string): string | undefined {
  const m = deviceUdid.match(/^U1\.([0-9a-fA-F-]{36})\./);
  return m ? m[1] : undefined;
}

/** Common SE-Client-* headers for every se-platform call. */
function seHeaders(opts: { token?: string; tenantId: string; json?: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    'SE-Client-API-Key': SE_CLIENT_API_KEY,
    'SE-Client-Locale': 'en-US',
    'SE-Client-Name': SE_CLIENT_NAME,
    'SE-Client-Type': SE_CLIENT_TYPE,
    'SE-Client-Version': SE_CLIENT_VERSION,
    'SE-Operating-System-Type': SE_OS_TYPE,
    'SE-Operating-System-Version': SE_OS_VERSION,
    'SE-Platform-ID': SE_PLATFORM_ID,
    'SE-SDK-Version': SE_SDK_VERSION,
    'User-Agent': SE_CLIENT_NAME,
    'X-NLok-Tenant-ID': opts.tenantId,
  };
  if (opts.json) h['Content-Type'] = 'application/json; charset=utf-8';
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  return h;
}

async function call(net: SeFetch, url: string, init: Parameters<SeFetch>[1]): Promise<SeResponse> {
  let res: SeResponse;
  try {
    res = await net(url, init);
  } catch (err) {
    throw new SeError('network', `se-platform request failed: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SeError('unauthorized', `se-platform returned HTTP ${res.status}`, res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SeError('http', `se-platform returned HTTP ${res.status}`, res.status);
  }
  return res;
}

async function asJson(res: SeResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new SeError('badResponse', 'se-platform response was not valid JSON');
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new SeError('badResponse', 'expected a JSON object');
  return v as Record<string, unknown>;
}

/** The se-platform envelope `{ status: { code }, data }`; returns `data`, or throws. */
function unwrap(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const status = asRecord(root.status ?? {});
  if (typeof status.code === 'number' && status.code !== 0) {
    throw new SeError('badResponse', `se-platform status code ${status.code}: ${String(status.message ?? '')}`);
  }
  return asRecord(root.data ?? {});
}

// ───────────────────────── step 1: Avast license → container_id ─────────────────────────

/** POST get-exact-application-licenses. Returns the license whose `id` is the container_id
 * associate-license needs. Throws `noLicense` if the wallet key resolves to nothing. */
export async function fetchLicense(walletKey: string, deviceFingerprint: string, net: SeFetch): Promise<SeLicense> {
  const res = await call(net, `${AVAST_LICENSE_HOST}/v1/query/get-exact-application-licenses`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Avast Antivirus',
      'Content-Type': 'application/json',
      'Vaar-Version': '0',
      'Vaar-Header-App-Build-Version': AVAST_APP_BUILD_VERSION,
      'Vaar-Header-App-Id': '00000000-0000-0000-0000-000000000000',
      'Vaar-Header-App-IPM-Product': AVAST_APP_IPM_PRODUCT,
      'Vaar-Header-App-Product-Brand': AVAST_APP_PRODUCT_BRAND,
      'Vaar-Header-App-Product-Edition': AVAST_APP_PRODUCT_EDITION,
      'Vaar-Header-App-Product-Mode': AVAST_APP_PRODUCT_MODE,
      'Vaar-Header-Device-Id': deviceFingerprint,
      'Vaar-Header-Device-Platform': 'WIN',
    },
    body: JSON.stringify({ walletKeys: [walletKey] }),
  });
  const payload = await asJson(res);
  const list = Array.isArray(payload) ? payload : [];
  for (const item of list) {
    const rec = item as Record<string, unknown>;
    if (typeof rec.id === 'string' && Array.isArray(rec.walletKeys) && rec.walletKeys.includes(walletKey)) {
      return {
        id: rec.id,
        walletKeys: rec.walletKeys.filter((k): k is string => typeof k === 'string'),
        expires: typeof rec.expires === 'number' ? rec.expires : undefined,
        mode: typeof rec.mode === 'string' ? rec.mode : undefined,
      };
    }
  }
  throw new SeError('noLicense', 'no license matched the wallet key');
}

// ───────────────────────── step 2: associate-license → token ─────────────────────────

/** POST aladdin/v1/authorization/associate-license. Mints (or refreshes) the device's
 * elysium JWT. Idempotent for a given (containerId, deviceFingerprint): the same device is
 * returned with a fresh token, so this doubles as token renewal. */
export async function associateLicense(
  args: { containerId: string; deviceFingerprint: string; walletKey: string; tenantId: string },
  net: SeFetch,
): Promise<SeDeviceToken> {
  const res = await call(net, `${SE_HOST}/aladdin/v1/authorization/associate-license`, {
    method: 'POST',
    headers: seHeaders({ tenantId: args.tenantId, json: true }),
    body: JSON.stringify({
      container_id: args.containerId,
      device_fingerprint: args.deviceFingerprint,
      wallet_key: args.walletKey,
    }),
  });
  const root = asRecord(await asJson(res));
  const deviceUdid = root.device_udid;
  const accessToken = root.access_token;
  const refreshToken = root.refresh_token;
  if (typeof deviceUdid !== 'string' || typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new SeError('badResponse', 'associate-license response missing device_udid/access_token/refresh_token');
  }
  return { deviceUdid, accessToken, refreshToken };
}

// ───────────────────────── step 3: passage credentials ─────────────────────────

/** PUT passage/v6/devices/{udid}/credentials (body `null`). Returns the device's OpenVPN
 * password + CA (and the PKCS#12 bundle for other protocols). */
export async function fetchDeviceCredentials(
  args: { deviceUdid: string; tenantId: string; token: string },
  net: SeFetch,
): Promise<SeDeviceCredentials> {
  const res = await call(net, `${SE_HOST}/passage/v6/devices/${encodeURIComponent(args.deviceUdid)}/credentials`, {
    method: 'PUT',
    headers: seHeaders({ token: args.token, tenantId: args.tenantId, json: true }),
    body: 'null',
  });
  const data = unwrap(await asJson(res));
  const cred = asRecord(data.credentials ?? {});
  const deviceUdid = cred.device_udid;
  const devicePassword = cred.device_password;
  const openvpnCa = cred.openvpn_ca_certificate;
  if (typeof deviceUdid !== 'string' || typeof devicePassword !== 'string' || typeof openvpnCa !== 'string') {
    throw new SeError('badResponse', 'passage credentials missing device_udid/device_password/openvpn_ca_certificate');
  }
  return {
    deviceUdid,
    devicePassword,
    openvpnCaCertificate: openvpnCa,
    certificate: typeof cred.certificate === 'string' ? cred.certificate : undefined,
    certificatePassword: typeof cred.certificate_password === 'string' ? cred.certificate_password : undefined,
  };
}

// ───────────────────────── step 4: geos (location list) ─────────────────────────

/** GET discovery/v12/geos → the full list of selectable countries and their cities. */
export async function fetchGeos(args: { tenantId: string; token: string }, net: SeFetch): Promise<SeGeoCountry[]> {
  const res = await call(net, `${SE_HOST}/discovery/v12/geos`, {
    method: 'GET',
    headers: seHeaders({ token: args.token, tenantId: args.tenantId }),
  });
  const data = unwrap(await asJson(res));
  const geos = Array.isArray(data.geos) ? data.geos : [];
  const out: SeGeoCountry[] = [];
  for (const g of geos) {
    const rec = g as Record<string, unknown>;
    if (typeof rec.location_key !== 'string') continue;
    if (rec.state !== undefined && rec.state !== 'active') continue;
    const cities: SeGeoCountry['cities'] = [];
    for (const c of Array.isArray(rec.cities) ? rec.cities : []) {
      const cr = c as Record<string, unknown>;
      if (typeof cr.location_key !== 'string') continue;
      cities.push({
        locationKey: cr.location_key,
        city: String(cr.location_city ?? cr.location_name ?? ''),
        active: cr.state === undefined || cr.state === 'active',
      });
    }
    out.push({
      locationKey: rec.location_key,
      countryCode: String(rec.country_code ?? rec.location_key),
      countryName: String(rec.country ?? rec.location_name ?? ''),
      active: true,
      cities,
    });
  }
  return out;
}

// ───────────────────────── step 5: discover (fresh gateways) ─────────────────────────

function toGateway(raw: unknown): SeGateway | undefined {
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ip !== 'string' || typeof rec.protocol !== 'string') return undefined;
  const geo = asRecord(rec.geo ?? {});
  const protocol = rec.protocol as SeProtocol;
  return {
    ip: rec.ip,
    protocol,
    ports: Array.isArray(rec.ports) ? rec.ports.filter((n): n is number => typeof n === 'number') : undefined,
    udpPorts: Array.isArray(rec.udp_ports) ? rec.udp_ports.filter((n): n is number => typeof n === 'number') : undefined,
    countryCode: String(geo.country_code ?? ''),
    locationKey: String(geo.location_key ?? ''),
    city: String(geo.city ?? ''),
  };
}

/** GET discovery/v9/discover?location_key=… → the location's current gateway pool.
 * Results are short-lived (≈120 s): call again for fresh IPs. */
export async function discover(
  args: { locationKey: string; tenantId: string; token: string },
  net: SeFetch,
): Promise<SeDiscoverResult> {
  const url = `${SE_HOST}/discovery/v9/discover?location_key=${encodeURIComponent(args.locationKey)}`;
  const res = await call(net, url, { method: 'GET', headers: seHeaders({ token: args.token, tenantId: args.tenantId }) });
  const data = unwrap(await asJson(res));
  const ips = Array.isArray(data.ips) ? data.ips : [];
  const gateways: SeGateway[] = [];
  for (const g of ips) {
    const gw = toGateway(g);
    if (gw) gateways.push(gw);
  }
  return {
    gateways,
    currentTime: typeof data.current_time === 'number' ? data.current_time : 0,
    expiresAt: typeof data.expires_at === 'number' ? data.expires_at : 0,
  };
}
