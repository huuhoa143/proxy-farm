/**
 * NordVPN access token → NordLynx private key (spec §5.5).
 *
 * The user creates an access token in Nord Account (NordVPN → Advanced settings → Get
 * access token). `GET /v1/users/services/credentials` with HTTP Basic `token:<token>`
 * answers `{username, password, nordlynx_private_key, …}` ✅ 2026-10-09. The app calls
 * it once, when the account is added, and keeps only the private key: the token is
 * never stored. Signing in with email/password (`POST /v1/users/tokens`) is behind a
 * Cloudflare challenge (403) and is not offered.
 *
 * Nord hands out the key even when the subscription has ended, but its servers then
 * never answer it (a port fails `key-rejected`) ✅ 2026-10-24. So the exchange also reads
 * `GET /v1/users/services`, as the app does (8.14.3 `v1/users/services`), and refuses an
 * account whose `vpn` service has expired.
 */
import type { FetchLike } from './servers';

export const CREDENTIALS_URL = 'https://api.nordvpn.com/v1/users/services/credentials';
export const SERVICES_URL = 'https://api.nordvpn.com/v1/users/services';

/** A Nord Account access token: 64 hex characters. */
export const ACCESS_TOKEN_RE = /^[0-9a-fA-F]{64}$/;
/** A WireGuard (NordLynx) private key: 32 bytes, base64. */
export const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const FETCH_TIMEOUT_MS = 20_000;

export type ExchangeResult = { ok: true; privateKey: string } | { ok: false; reasonKey: string };

/** `2026-10-12 07:47:46` (UTC) → epoch ms; NaN when unreadable. */
function nordTime(v: unknown): number {
  return typeof v === 'string' ? Date.parse(`${v.trim().replace(' ', 'T')}Z`) : NaN;
}

/**
 * The account's NordVPN service is active at `nowMs`: `true`, `false`, or `undefined`
 * when the services list could not be read (then the key is given the benefit of the
 * doubt; a dead key still ends `key-rejected`).
 */
async function vpnServiceActive(authorization: string, fetchImpl: FetchLike, nowMs: number): Promise<boolean | undefined> {
  try {
    const res = await fetchImpl(SERVICES_URL, { headers: { accept: 'application/json', authorization }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = await res.json();
    if (!Array.isArray(body)) return undefined;
    const vpn = (body as Array<Record<string, unknown>>).filter((s) => (s?.service as Record<string, unknown> | undefined)?.identifier === 'vpn');
    return vpn.some((s) => nordTime(s.expires_at) > nowMs);
  } catch {
    return undefined;
  }
}

/**
 * One credentials call, then one services call. 401/403 = the token was refused (wrong, expired or revoked);
 * a network failure or any other answer = Nord could not be reached; a 200 without a
 * NordLynx key = the account has no usable NordVPN service; a `vpn` service that has
 * ended = expired. Never throws, and never puts the token or the key in a message.
 */
export async function exchangeAccessToken(
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: () => number = Date.now,
): Promise<ExchangeResult> {
  const authorization = `Basic ${Buffer.from(`token:${token}`).toString('base64')}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(CREDENTIALS_URL, {
      headers: { accept: 'application/json', authorization },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reasonKey: 'nordvpn.check.networkError' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reasonKey: 'nordvpn.check.tokenRejected' };
  if (!res.ok) return { ok: false, reasonKey: 'nordvpn.check.networkError' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reasonKey: 'nordvpn.check.networkError' };
  }
  const key = (body as { nordlynx_private_key?: unknown } | null)?.nordlynx_private_key;
  if (typeof key !== 'string' || !WG_KEY_RE.test(key)) return { ok: false, reasonKey: 'nordvpn.check.noKey' };
  if ((await vpnServiceActive(authorization, fetchImpl, now())) === false) return { ok: false, reasonKey: 'nordvpn.check.expired' };
  return { ok: true, privateKey: key };
}
