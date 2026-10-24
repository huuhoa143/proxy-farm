/**
 * Surfshark account API client (pure request/response; network injected as `SsFetch`).
 *
 * Every call builds the request the Surfshark Windows app sends to api.surfshark.com
 * (docs/SURFSHARK-API.md) and parses only what proxy-farm needs. Errors are thrown as
 * `SsError` with a stable `kind` the provider maps to an i18n key; nothing here persists
 * state or touches disk. The mTLS client certificate is the `SsFetch`'s concern (account/net.ts).
 */
import { SS_API_BASE, SS_DEVICE, SS_ENDPOINTS, SS_USER_AGENT } from './constants';
import type { SsFetch, SsPublicKey, SsResponse, SsTokens } from './types';

export type SsErrorKind =
  | 'network' // request never completed (offline, DNS, TLS)
  | 'http' // non-2xx status
  | 'badResponse' // 2xx but the body was not the shape we expect
  | 'invalidCredentials' // 401/403 on login — wrong email/password
  | 'twoFactorRequired' // login needs a 2FA / login code
  | 'unauthorized'; // 401/403 on an authenticated call — token rejected

export class SsError extends Error {
  constructor(
    readonly kind: SsErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SsError';
  }
}

/** Device headers (`x-device-*`) + User-Agent, on every call. `deviceId` is proxy-farm's own
 * stable fingerprint. */
function deviceHeaders(deviceId: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': SS_USER_AGENT,
    'SS-GENERATED-AT': new Date().toISOString(),
    'x-device-id': deviceId,
    'x-device-type': SS_DEVICE.type,
    'x-device-platform': SS_DEVICE.platform,
    'x-device-brand': SS_DEVICE.brand,
    'x-device-model': SS_DEVICE.model,
    'x-device-version': SS_DEVICE.appVersion,
  };
}

function authHeaders(deviceId: string, token?: string, json = false): Record<string, string> {
  const h = deviceHeaders(deviceId);
  if (json) h['Content-Type'] = 'application/json; charset=utf-8';
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function call(net: SsFetch, path: string, init: Parameters<SsFetch>[1], onAuth?: SsErrorKind): Promise<SsResponse> {
  let res: SsResponse;
  try {
    res = await net(`${SS_API_BASE}${path}`, init);
  } catch (err) {
    throw new SsError('network', `surfshark request failed: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SsError(onAuth ?? 'unauthorized', `surfshark returned HTTP ${res.status}`, res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SsError('http', `surfshark returned HTTP ${res.status}`, res.status);
  }
  return res;
}

async function asRecord(res: SsResponse): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SsError('badResponse', 'surfshark response was not valid JSON');
  }
  if (typeof body !== 'object' || body === null) throw new SsError('badResponse', 'expected a JSON object');
  return body as Record<string, unknown>;
}

/** Read a field by any of several names (the wire casing of typed DTOs is not guaranteed). */
function pick(rec: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (rec[n] !== undefined) return rec[n];
  return undefined;
}

function parseTokens(rec: Record<string, unknown>): SsTokens {
  const renewalToken = pick(rec, 'renewalToken', 'renewToken', 'RenewalToken');
  const authenticationToken = pick(rec, 'authenticationToken', 'token', 'AuthenticationToken', 'accessToken');
  if (typeof renewalToken !== 'string' || typeof authenticationToken !== 'string') {
    throw new SsError('badResponse', 'surfshark auth response missing renewalToken/authenticationToken');
  }
  return { renewalToken, authenticationToken };
}

// ───────────────────────── auth ─────────────────────────

/** POST /v1/auth/login with email + password. Returns the token pair, or throws
 * `invalidCredentials` / `twoFactorRequired`. */
export async function login(
  args: { username: string; password: string; deviceId: string },
  net: SsFetch,
): Promise<SsTokens> {
  const res = await call(
    net,
    SS_ENDPOINTS.login,
    { method: 'POST', headers: authHeaders(args.deviceId, undefined, true), body: JSON.stringify({ username: args.username, password: args.password }) },
    'invalidCredentials',
  );
  return parseTokens(await asRecord(res));
}

/** POST /v1/auth/renew → a fresh access token. The renewal token is sent as the Bearer
 * credential (confirmed live), not in the body; the response is `{token}` and usually keeps
 * the same renewal token, so a missing `renewToken` in the reply falls back to the current one. */
export async function renewTokens(args: { renewalToken: string; deviceId: string }, net: SsFetch): Promise<SsTokens> {
  const res = await call(net, SS_ENDPOINTS.renew, {
    method: 'POST',
    headers: authHeaders(args.deviceId, args.renewalToken, true),
    body: '{}',
  });
  const rec = await asRecord(res);
  const authenticationToken = pick(rec, 'token', 'authenticationToken', 'accessToken');
  if (typeof authenticationToken !== 'string') throw new SsError('badResponse', 'surfshark renew response missing token');
  const renewed = pick(rec, 'renewToken', 'renewalToken', 'RenewalToken');
  return { authenticationToken, renewalToken: typeof renewed === 'string' ? renewed : args.renewalToken };
}

// ───────────────────────── WireGuard key registration ─────────────────────────

function parsePublicKey(rec: Record<string, unknown>): SsPublicKey {
  const publicKey = pick(rec, 'publicKey', 'PublicKey', 'pubKey');
  const expiresRaw = pick(rec, 'expiresAt', 'ExpiresAt', 'expiresAtUtc');
  if (typeof publicKey !== 'string') throw new SsError('badResponse', 'public-keys response missing PublicKey');
  const expiresAtMs = typeof expiresRaw === 'string' ? Date.parse(expiresRaw) : typeof expiresRaw === 'number' ? expiresRaw : NaN;
  if (!Number.isFinite(expiresAtMs)) throw new SsError('badResponse', 'public-keys response missing/invalid ExpiresAt');
  return { publicKey, expiresAtMs };
}

/** POST /v1/account/users/public-keys `{pubKey}` → the registered key + its expiry. The
 * server completes a WireGuard handshake only for a registered, non-expired key. */
export async function registerPublicKey(
  args: { pubKey: string; deviceId: string; token: string },
  net: SsFetch,
): Promise<SsPublicKey> {
  const res = await call(net, SS_ENDPOINTS.registerPublicKey, {
    method: 'POST',
    headers: authHeaders(args.deviceId, args.token, true),
    body: JSON.stringify({ pubKey: args.pubKey }),
  });
  return parsePublicKey(await asRecord(res));
}

/** POST /v1/account/users/public-keys/validate `{pubKey}` → whether the key is still valid.
 * A non-2xx (other than auth) or an explicit `{valid:false}` means re-register. */
export async function validatePublicKey(
  args: { pubKey: string; deviceId: string; token: string },
  net: SsFetch,
): Promise<boolean> {
  let res: SsResponse;
  try {
    res = await call(net, SS_ENDPOINTS.validatePublicKey, {
      method: 'POST',
      headers: authHeaders(args.deviceId, args.token, true),
      body: JSON.stringify({ pubKey: args.pubKey }),
    });
  } catch (err) {
    if (err instanceof SsError && err.kind === 'http') return false;
    throw err;
  }
  try {
    const rec = await asRecord(res);
    const valid = pick(rec, 'valid', 'isValid', 'Valid');
    return valid === undefined ? true : valid === true;
  } catch {
    return true; // 2xx with no/odd body: treat as valid
  }
}
