/**
 * NordVPN access token → NordLynx private key (spec §5.5).
 *
 * The user creates an access token in Nord Account (NordVPN → Advanced settings → Get
 * access token). `GET /v1/users/services/credentials` with HTTP Basic `token:<token>`
 * answers `{username, password, nordlynx_private_key, …}` ✅ 2026-10-09. The app calls
 * it once, when the account is added, and keeps only the private key: the token is
 * never stored. Signing in with email/password (`POST /v1/users/tokens`) is behind a
 * Cloudflare challenge (403) and is not offered.
 */
import type { FetchLike } from './servers';

export const CREDENTIALS_URL = 'https://api.nordvpn.com/v1/users/services/credentials';

/** A Nord Account access token: 64 hex characters. */
export const ACCESS_TOKEN_RE = /^[0-9a-fA-F]{64}$/;
/** A WireGuard (NordLynx) private key: 32 bytes, base64. */
export const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const FETCH_TIMEOUT_MS = 20_000;

export type ExchangeResult = { ok: true; privateKey: string } | { ok: false; reasonKey: string };

/**
 * One credentials call. 401/403 = the token was refused (wrong, expired or revoked);
 * a network failure or any other answer = Nord could not be reached; a 200 without a
 * NordLynx key = the account has no usable NordVPN service. Never throws, and never
 * puts the token or the key in a message.
 */
export async function exchangeAccessToken(token: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ExchangeResult> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(CREDENTIALS_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`token:${token}`).toString('base64')}`,
      },
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
  return { ok: true, privateKey: key };
}
