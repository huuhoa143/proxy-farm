import { describe, expect, it } from 'vitest';
import {
  createTokenMinter,
  ensureKeyFresh,
  identityFromMeta,
  identityToMeta,
  jwtExpSeconds,
  registerAccount,
  type AccountIdentity,
} from './session';
import { wgPublicKey } from '../../wg-key';
import type { SsFetch } from './types';

/** A JWT (unsigned) carrying only `exp` (epoch seconds). */
function jwt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.sig`;
}

function fakeNet(handler: (url: string, body: unknown, method: string) => { status: number; body?: unknown }): {
  net: SsFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const net: SsFetch = async (url, init) => {
    urls.push(url);
    const r = handler(url, init.body ? JSON.parse(init.body) : undefined, init.method);
    return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body ?? '') };
  };
  return { net, urls };
}

describe('jwtExpSeconds', () => {
  it('reads exp from a JWT payload', () => {
    expect(jwtExpSeconds(jwt(1_700_000_000))).toBe(1_700_000_000);
  });
  it('undefined for garbage', () => {
    expect(jwtExpSeconds('not-a-jwt')).toBeUndefined();
  });
});

describe('registerAccount', () => {
  it('logs in, generates a key, registers its public key, and returns identity + secrets', async () => {
    let registeredPub: string | undefined;
    const { net, urls } = fakeNet((url, body) => {
      if (url.endsWith('/v1/auth/login')) return { status: 200, body: { renewalToken: 'R', authenticationToken: jwt(2_000_000_000) } };
      if (url.endsWith('/v1/account/users/public-keys')) {
        registeredPub = (body as { pubKey: string }).pubKey;
        return { status: 200, body: { publicKey: registeredPub, expiresAt: '2030-01-01T00:00:00Z' } };
      }
      return { status: 404 };
    });
    const reg = await registerAccount({ username: 'u@e.com', password: 'pw' }, net, { deviceFingerprint: 'f'.repeat(64) });
    expect(urls).toEqual([
      'https://api.surfshark.com/v1/auth/login',
      'https://api.surfshark.com/v1/account/users/public-keys',
    ]);
    // The registered public key is the one derived from the generated private key.
    expect(reg.identity.publicKey).toBe(registeredPub);
    expect(wgPublicKey(reg.privateKey)).toBe(reg.identity.publicKey);
    expect(reg.renewalToken).toBe('R');
    expect(reg.identity.deviceFingerprint).toBe('f'.repeat(64));
    expect(reg.identity.keyExpiresAtMs).toBe(Date.parse('2030-01-01T00:00:00Z'));
    expect(reg.identity.address).toBe('10.14.0.2/16');
  });
});

describe('createTokenMinter', () => {
  it('returns the seed token while fresh, renewing only when near expiry', async () => {
    const now = () => 1_000_000_000_000; // ms
    let renews = 0;
    const { net } = fakeNet((url) => {
      if (url.endsWith('/v1/auth/renew')) {
        renews++;
        return { status: 200, body: { renewalToken: `R${renews}`, authenticationToken: jwt(now() / 1000 + 86400) } };
      }
      return { status: 404 };
    });
    const freshSeed = jwt(now() / 1000 + 86400); // 1 day ahead → fresh
    const minter = createTokenMinter({ renewalToken: 'R0', deviceId: 'd', seedToken: freshSeed }, net, { now });
    expect(await minter.getToken()).toBe(freshSeed);
    expect(renews).toBe(0);

    const staleSeed = jwt(now() / 1000 + 10); // within skew → must renew
    const minter2 = createTokenMinter({ renewalToken: 'R0', deviceId: 'd', seedToken: staleSeed }, net, { now });
    const t = await minter2.getToken();
    expect(t).not.toBe(staleSeed);
    expect(renews).toBe(1);
    expect(minter2.renewalToken()).toBe('R1'); // rotated renewal token is kept
  });
});

describe('ensureKeyFresh', () => {
  const identity: AccountIdentity = {
    deviceFingerprint: 'd'.repeat(64),
    publicKey: 'PUB',
    keyExpiresAtMs: 0,
    address: '10.14.0.2/16',
  };

  it('re-registers when within the renew window and returns a new expiry', async () => {
    const now = () => 1_000_000_000_000;
    const { net, urls } = fakeNet((url) => {
      if (url.endsWith('/v1/account/users/public-keys')) return { status: 200, body: { publicKey: 'PUB', expiresAt: '2035-01-01T00:00:00Z' } };
      return { status: 404 };
    });
    const minter = createTokenMinter({ renewalToken: 'R', deviceId: identity.deviceFingerprint, seedToken: jwt(now() / 1000 + 86400) }, net, { now });
    const soon: AccountIdentity = { ...identity, keyExpiresAtMs: now() + 60_000 }; // 1 min away
    const fresh = await ensureKeyFresh({ identity: soon, minter }, net, { now });
    expect(fresh?.keyExpiresAtMs).toBe(Date.parse('2035-01-01T00:00:00Z'));
    expect(urls.some((u) => u.endsWith('/public-keys'))).toBe(true);
  });

  it('does nothing when the key is still far from expiry', async () => {
    const now = () => 1_000_000_000_000;
    const { net, urls } = fakeNet(() => ({ status: 500 }));
    const minter = createTokenMinter({ renewalToken: 'R', deviceId: identity.deviceFingerprint, seedToken: jwt(now() / 1000 + 86400) }, net, { now });
    const far: AccountIdentity = { ...identity, keyExpiresAtMs: now() + 10 * 86_400_000 }; // 10 days
    expect(await ensureKeyFresh({ identity: far, minter }, net, { now })).toBeUndefined();
    expect(urls).toEqual([]);
  });
});

describe('identity meta round-trip', () => {
  it('packs and unpacks', () => {
    const id: AccountIdentity = { deviceFingerprint: 'f'.repeat(64), publicKey: 'PUB', keyExpiresAtMs: 123456, address: '10.64.1.2/16' };
    const meta = identityToMeta(id);
    expect(meta.source).toBe('account');
    expect(identityFromMeta(meta)).toEqual(id);
  });
  it('rejects meta from another source', () => {
    expect(identityFromMeta({ source: 'manual' })).toBeUndefined();
  });
});
