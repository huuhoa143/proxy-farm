import { describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_URL, exchangeAccessToken } from './credentials';
import type { FetchLike } from './servers';

// Dummy values of the right shape, not real credentials.
const TOKEN = 'ab'.repeat(32);
const NORDLYNX_KEY = 'kNWOz8Z0Ft2V0vHn8bU1Hc0w2m9yBq7Ri3sXkQe1hGc=';

function answer(status: number, body: unknown): FetchLike {
  return vi.fn<FetchLike>(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

describe('exchangeAccessToken', () => {
  it('calls the credentials endpoint once with HTTP Basic token:<token> and returns the NordLynx key only', async () => {
    const fetchImpl = answer(200, { id: 1, username: 'u'.repeat(24), password: 'p'.repeat(24), nordlynx_private_key: NORDLYNX_KEY });
    expect(await exchangeAccessToken(TOKEN, fetchImpl)).toEqual({ ok: true, privateKey: NORDLYNX_KEY });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(CREDENTIALS_URL);
    expect(init?.headers?.authorization).toBe(`Basic ${Buffer.from(`token:${TOKEN}`).toString('base64')}`);
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
