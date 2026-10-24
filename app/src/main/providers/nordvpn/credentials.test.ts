import { describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_URL, exchangeAccessToken, SERVICES_URL } from './credentials';
import type { FetchLike } from './servers';

// Dummy values of the right shape, not real credentials.
const TOKEN = 'ab'.repeat(32);
const NORDLYNX_KEY = 'kNWOz8Z0Ft2V0vHn8bU1Hc0w2m9yBq7Ri3sXkQe1hGc=';

function answer(status: number, body: unknown): FetchLike {
  return vi.fn<FetchLike>(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

const NOW = Date.parse('2026-10-24T06:00:00Z');
const CREDS = { id: 1, username: 'u'.repeat(24), password: 'p'.repeat(24), nordlynx_private_key: NORDLYNX_KEY };
/** Nord's services list: the `vpn` service ending at `vpnUntil` (Nord's UTC format). */
const services = (vpnUntil: string) => [
  { service: { identifier: 'vpn' }, expires_at: vpnUntil },
  { service: { identifier: 'meshnet' }, expires_at: '2050-01-01 00:00:00' },
];

/** Credentials answer `creds`, services answer `svc` (or fail when it is an Error). */
function nord(svc: { status: number; body?: unknown } | Error, creds: unknown = CREDS): FetchLike {
  return vi.fn<FetchLike>(async (url) => {
    if (url === CREDENTIALS_URL) return { ok: true, status: 200, json: async () => creds };
    if (url === SERVICES_URL) {
      if (svc instanceof Error) throw svc;
      return { ok: svc.status === 200, status: svc.status, json: async () => svc.body };
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe('exchangeAccessToken', () => {
  it('reads credentials then services, with HTTP Basic token:<token>, and returns the NordLynx key only', async () => {
    const fetchImpl = nord({ status: 200, body: services('2026-11-12 07:47:46') });
    expect(await exchangeAccessToken(TOKEN, fetchImpl, () => NOW)).toEqual({ ok: true, privateKey: NORDLYNX_KEY });
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([CREDENTIALS_URL, SERVICES_URL]);
    for (const [, init] of calls) expect(init?.headers?.authorization).toBe(`Basic ${Buffer.from(`token:${TOKEN}`).toString('base64')}`);
  });

  it('refuses an account whose NordVPN service has ended, or that has none', async () => {
    // the live case of 2026-10-24: the key came back, the vpn service ended on 10-12
    expect(await exchangeAccessToken(TOKEN, nord({ status: 200, body: services('2026-10-12 07:47:46') }), () => NOW)).toEqual({
      ok: false,
      reasonKey: 'nordvpn.check.expired',
    });
    expect(await exchangeAccessToken(TOKEN, nord({ status: 200, body: services('2026-11-12 07:47:46').slice(1) }), () => NOW)).toEqual({
      ok: false,
      reasonKey: 'nordvpn.check.expired',
    });
  });

  it('keeps the key when the services list cannot be read (the port check still catches a dead key)', async () => {
    for (const svc of [new TypeError('fetch failed'), { status: 500, body: {} }, { status: 200, body: { odd: true } }]) {
      expect(await exchangeAccessToken(TOKEN, nord(svc), () => NOW)).toEqual({ ok: true, privateKey: NORDLYNX_KEY });
    }
  });

  it('maps 401 and 403 to "token rejected"', async () => {
    for (const status of [401, 403]) {
      expect(await exchangeAccessToken(TOKEN, answer(status, { errors: { message: 'Unauthorized' } }))).toEqual({ ok: false, reasonKey: 'nordvpn.check.tokenRejected' });
    }
  });

  it('maps a network failure, another HTTP status or a non-JSON body to "network error"', async () => {
    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const notJson: FetchLike = async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('bad json')) });
    for (const fetchImpl of [offline, answer(500, {}), answer(429, {}), notJson]) {
      expect(await exchangeAccessToken(TOKEN, fetchImpl)).toEqual({ ok: false, reasonKey: 'nordvpn.check.networkError' });
    }
  });

  it('a 200 without a well-formed NordLynx key is "no key"', async () => {
    for (const body of [{}, { nordlynx_private_key: '' }, { nordlynx_private_key: 'short=' }, null]) {
      expect(await exchangeAccessToken(TOKEN, answer(200, body))).toEqual({ ok: false, reasonKey: 'nordvpn.check.noKey' });
    }
  });
});
