import { describe, expect, it } from 'vitest';
import { login, registerPublicKey, renewTokens, SsError, validatePublicKey } from './client';
import type { SsFetch } from './types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake SsFetch that records calls and replies from a queue of {status, body}. */
function fakeNet(replies: Array<{ status: number; body?: unknown }>): { net: SsFetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const net: SsFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = replies[Math.min(i++, replies.length - 1)];
    return {
      status: r.status,
      json: async () => (r.body === undefined ? (() => { throw new Error('no body'); })() : r.body),
      text: async () => JSON.stringify(r.body ?? ''),
    };
  };
  return { net, calls };
}

const DEVICE = 'a'.repeat(64);

describe('surfshark account client: login', () => {
  it('POSTs username/password and returns the token pair', async () => {
    const { net, calls } = fakeNet([{ status: 200, body: { renewalToken: 'R', authenticationToken: 'A' } }]);
    const tokens = await login({ username: 'u@e.com', password: 'pw', deviceId: DEVICE }, net);
    expect(tokens).toEqual({ renewalToken: 'R', authenticationToken: 'A' });
    expect(calls[0].url).toBe('https://api.surfshark.com/v1/auth/login');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ username: 'u@e.com', password: 'pw' });
    expect(calls[0].headers['x-device-id']).toBe(DEVICE);
    expect(calls[0].headers['x-device-type']).toBe('desktop');
    expect(calls[0].headers['User-Agent']).toContain('SurfsharkWindows/');
  });

  it('maps 401 to invalidCredentials', async () => {
    const { net } = fakeNet([{ status: 401 }]);
    await expect(login({ username: 'u', password: 'bad', deviceId: DEVICE }, net)).rejects.toMatchObject({
      name: 'SsError',
      kind: 'invalidCredentials',
    });
  });

  it('accepts the real wire shape {token, renewToken}', async () => {
    // Confirmed live 2026-10-24: /v1/auth/login returns `token` + `renewToken`.
    const { net } = fakeNet([{ status: 200, body: { token: 'A', renewToken: 'R' } }]);
    expect(await login({ username: 'u', password: 'p', deviceId: DEVICE }, net)).toEqual({ renewalToken: 'R', authenticationToken: 'A' });
  });

  it('throws badResponse when tokens are missing', async () => {
    const { net } = fakeNet([{ status: 200, body: { nope: 1 } }]);
    await expect(login({ username: 'u', password: 'p', deviceId: DEVICE }, net)).rejects.toMatchObject({ kind: 'badResponse' });
  });
});

describe('surfshark account client: renewTokens', () => {
  it('sends the renewal token as the Bearer credential (not body) and returns the fresh access token', async () => {
    // Confirmed live: renew needs Authorization: Bearer <renewToken>, empty body, replies {token}.
    const { net, calls } = fakeNet([{ status: 200, body: { token: 'A2' } }]);
    const tokens = await renewTokens({ renewalToken: 'R1', deviceId: DEVICE }, net);
    expect(calls[0].url).toBe('https://api.surfshark.com/v1/auth/renew');
    expect(calls[0].headers.Authorization).toBe('Bearer R1');
    expect(calls[0].body).toEqual({}); // empty body
    // No renewToken in the reply → keep the current one.
    expect(tokens).toEqual({ renewalToken: 'R1', authenticationToken: 'A2' });
  });

  it('adopts a rotated renewToken when the reply carries one', async () => {
    const { net } = fakeNet([{ status: 200, body: { token: 'A2', renewToken: 'R2' } }]);
    expect(await renewTokens({ renewalToken: 'R1', deviceId: DEVICE }, net)).toEqual({ renewalToken: 'R2', authenticationToken: 'A2' });
  });
});

describe('surfshark account client: registerPublicKey', () => {
  it('POSTs {pubKey} with Bearer and parses PublicKey/ExpiresAt (camelCase)', async () => {
    const { net, calls } = fakeNet([{ status: 200, body: { publicKey: 'PUB', expiresAt: '2030-01-01T00:00:00Z' } }]);
    const res = await registerPublicKey({ pubKey: 'PUB', deviceId: DEVICE, token: 'TOK' }, net);
    expect(res.publicKey).toBe('PUB');
    expect(res.expiresAtMs).toBe(Date.parse('2030-01-01T00:00:00Z'));
    expect(calls[0].url).toBe('https://api.surfshark.com/v1/account/users/public-keys');
    expect(calls[0].body).toEqual({ pubKey: 'PUB' });
    expect(calls[0].headers.Authorization).toBe('Bearer TOK');
  });

  it('also accepts PascalCase response fields', async () => {
    const { net } = fakeNet([{ status: 200, body: { PublicKey: 'PUB', ExpiresAt: '2030-06-01T00:00:00Z' } }]);
    const res = await registerPublicKey({ pubKey: 'PUB', deviceId: DEVICE, token: 'TOK' }, net);
    expect(res.expiresAtMs).toBe(Date.parse('2030-06-01T00:00:00Z'));
  });

  it('maps 403 to unauthorized', async () => {
    const { net } = fakeNet([{ status: 403 }]);
    await expect(registerPublicKey({ pubKey: 'P', deviceId: DEVICE, token: 'T' }, net)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});

describe('surfshark account client: validatePublicKey', () => {
  it('true on 2xx', async () => {
    const { net } = fakeNet([{ status: 200, body: { valid: true } }]);
    expect(await validatePublicKey({ pubKey: 'P', deviceId: DEVICE, token: 'T' }, net)).toBe(true);
  });
  it('false on {valid:false}', async () => {
    const { net } = fakeNet([{ status: 200, body: { valid: false } }]);
    expect(await validatePublicKey({ pubKey: 'P', deviceId: DEVICE, token: 'T' }, net)).toBe(false);
  });
  it('false on a non-auth HTTP error', async () => {
    const { net } = fakeNet([{ status: 404 }]);
    expect(await validatePublicKey({ pubKey: 'P', deviceId: DEVICE, token: 'T' }, net)).toBe(false);
  });
});

describe('surfshark account client: network errors', () => {
  it('wraps a thrown fetch as SsError network', async () => {
    const net: SsFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(login({ username: 'u', password: 'p', deviceId: DEVICE }, net)).rejects.toMatchObject({ kind: 'network' });
    expect(new SsError('network', 'x').name).toBe('SsError');
  });
});
