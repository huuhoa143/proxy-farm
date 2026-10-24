import { describe, expect, it, vi } from 'vitest';
import {
  createTokenMinter,
  credentialsDue,
  identityFromMeta,
  identityToMeta,
  newDeviceFingerprint,
  registerDevice,
  withToken,
  type DeviceIdentity,
} from './device';
import { SeError } from './client';
import { HMA_TENANT_ID } from './constants';
import { jwtExpSeconds } from './jwt';
import { discoverFeed, gatewaysToCatalog } from './discover-source';
import type { SeFetch, SeGateway, SeResponse } from './types';

const TENANT = '11111111-2222-3333-4444-555555555555';
const UDID = `U1.${TENANT}.hma101.${'AB'.repeat(32)}`;
const WALLET = 'TEST00-TEST11-TEST22';

/** A signature-less JWT with the given exp (seconds). */
function fakeJwt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSec, sub: UDID })}.sig`;
}

function jsonRes(status: number, body: unknown): SeResponse {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

function routeNet(routes: Record<string, (init: Parameters<SeFetch>[1]) => SeResponse>): {
  net: SeFetch;
  hits: Record<string, number>;
} {
  const hits: Record<string, number> = {};
  const net: SeFetch = async (url, init) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k))!;
    hits[key] = (hits[key] ?? 0) + 1;
    return routes[key](init);
  };
  return { net, hits };
}

const LICENSE_URL = 'https://my-win.avast.com/v1/query/get-exact-application-licenses';
const ASSOC_URL = 'https://api.se-platform.com/aladdin/v1/authorization/associate-license';
const PASSAGE_URL = 'https://api.se-platform.com/passage/v6/devices/';
const DISCOVER_URL = 'https://api.se-platform.com/discovery/v9/discover';
const RENEW_URL = 'https://api.se-platform.com/elysium/v1/renew';

describe('jwtExpSeconds', () => {
  it('reads exp from a well-formed token', () => {
    expect(jwtExpSeconds(fakeJwt(1792812177))).toBe(1792812177);
  });
  it('returns undefined for junk', () => {
    expect(jwtExpSeconds('nope')).toBeUndefined();
  });
});

describe('newDeviceFingerprint', () => {
  it('is 64 hex chars and random', () => {
    const a = newDeviceFingerprint();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(newDeviceFingerprint());
  });
});

describe('registerDevice', () => {
  it('runs license→associate→passage and returns identity + creds', async () => {
    const { net, hits } = routeNet({
      [LICENSE_URL]: () => jsonRes(200, [{ id: 'container-xyz', walletKeys: [WALLET] }]),
      [ASSOC_URL]: () => jsonRes(200, { device_udid: UDID, access_token: fakeJwt(9e9), refresh_token: 'r' }),
      [PASSAGE_URL]: () =>
        jsonRes(200, {
          status: { code: 0 },
          data: { credentials: { device_udid: UDID, device_password: 'PW'.repeat(32), openvpn_ca_certificate: 'CA-PEM' } },
        }),
    });
    const dev = await registerDevice(WALLET, net, { deviceFingerprint: 'fp', tenant: TENANT });
    expect(dev.username).toBe(UDID);
    expect(dev.password).toBe('PW'.repeat(32));
    expect(dev.identity.containerId).toBe('container-xyz');
    expect(dev.identity.tenant).toBe(TENANT); // echoed from the udid
    expect(dev.identity.openvpnCaCertificate).toBe('CA-PEM');
    expect(hits[LICENSE_URL]).toBe(1);
  });

  it('generates a fingerprint and registers under the HMA tenant when none given', async () => {
    const tenantsSent: string[] = [];
    const { net } = routeNet({
      [LICENSE_URL]: () => jsonRes(200, [{ id: 'c', walletKeys: [WALLET] }]),
      [ASSOC_URL]: (init) => {
        tenantsSent.push(init!.headers!['X-NLok-Tenant-ID']);
        return jsonRes(200, { device_udid: UDID, access_token: fakeJwt(9e9), refresh_token: 'r' });
      },
      [PASSAGE_URL]: () =>
        jsonRes(200, { status: { code: 0 }, data: { credentials: { device_udid: UDID, device_password: 'p', openvpn_ca_certificate: 'ca' } } }),
    });
    const dev = await registerDevice(WALLET, net);
    expect(dev.identity.deviceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(dev.identity.tenant).toBe(TENANT); // from the returned udid
    expect(tenantsSent).toEqual([HMA_TENANT_ID]); // the app's tenant, not a made-up one
    expect(dev.refreshToken).toBe('r');
    expect(typeof dev.identity.credentialsAt).toBe('number');
  });
});

describe('identity meta roundtrip', () => {
  it('packs to a flat string map and back', () => {
    const id: DeviceIdentity = {
      deviceFingerprint: 'fp',
      tenant: TENANT,
      containerId: 'c',
      deviceUdid: UDID,
      openvpnCaCertificate: 'CA',
      credentialsAt: 1_700_000_000_000,
    };
    const meta = identityToMeta(id);
    expect(meta.source).toBe('se-platform');
    expect(meta.credsAt).toBe('1700000000000');
    expect(meta.walletKey).toBeUndefined(); // the license key is never written to meta
    expect(identityFromMeta(meta)).toEqual(id);
  });
  it('rejects meta from another source or missing fields', () => {
    expect(identityFromMeta({ source: 'local' })).toBeUndefined();
    expect(identityFromMeta({ source: 'se-platform', deviceFingerprint: 'fp' })).toBeUndefined();
  });
});

describe('credentialsDue', () => {
  const WEEK = 7 * 24 * 3600 * 1000;
  it('is due after 7 days, or when the age is unknown', () => {
    expect(credentialsDue({ credentialsAt: 1000 }, 1000 + WEEK - 1, WEEK)).toBe(false);
    expect(credentialsDue({ credentialsAt: 1000 }, 1000 + WEEK, WEEK)).toBe(true);
    expect(credentialsDue({}, 1000, WEEK)).toBe(true);
  });
});

describe('createTokenMinter', () => {
  const identity = { deviceFingerprint: 'fp', tenant: TENANT, containerId: 'c', deviceUdid: UDID };

  it('reuses a fresh seed token without calling the API', async () => {
    const { net, hits } = routeNet({ [ASSOC_URL]: () => jsonRes(200, {}) });
    const nowMs = 1_000_000_000_000;
    const minter = createTokenMinter(identity, WALLET, net, { now: () => nowMs, seedToken: fakeJwt(nowMs / 1000 + 6 * 3600) });
    expect(await minter.getToken()).toContain('.');
    expect(hits[ASSOC_URL]).toBeUndefined();
  });

  it('re-mints when the token is within the refresh skew of expiry', async () => {
    const nowMs = 1_000_000_000_000;
    const fresh = fakeJwt(nowMs / 1000 + 10 * 3600);
    const { net, hits } = routeNet({
      [ASSOC_URL]: () => jsonRes(200, { device_udid: UDID, access_token: fresh, refresh_token: 'r' }),
    });
    const minter = createTokenMinter(identity, WALLET, net, { now: () => nowMs, seedToken: fakeJwt(nowMs / 1000 + 2 * 60) });
    const t = await minter.getToken();
    expect(t).toBe(fresh);
    expect(hits[ASSOC_URL]).toBe(1);
    // second call now fresh → no extra mint
    await minter.getToken();
    expect(hits[ASSOC_URL]).toBe(1);
  });

  it('renews with the refresh token (not associate) and hands back the rotated one', async () => {
    const nowMs = 1_000_000_000_000;
    const next = fakeJwt(nowMs / 1000 + 12 * 3600);
    const { net, hits } = routeNet({
      [RENEW_URL]: () => jsonRes(200, { access_token: next, refresh_token: 'r2' }),
      [ASSOC_URL]: () => jsonRes(500, {}),
    });
    const saved: string[] = [];
    const minter = createTokenMinter(identity, WALLET, net, { now: () => nowMs, refreshToken: 'r1', onRefreshToken: (t) => saved.push(t) });
    expect(await minter.getToken()).toBe(next);
    expect(hits[RENEW_URL]).toBe(1);
    expect(hits[ASSOC_URL]).toBeUndefined();
    expect(saved).toEqual(['r2']);
    expect(minter.refreshToken()).toBe('r2');
  });

  it('falls back to associate-license when the refresh token is refused', async () => {
    const nowMs = 1_000_000_000_000;
    const minted = fakeJwt(nowMs / 1000 + 12 * 3600);
    const { net, hits } = routeNet({
      [RENEW_URL]: () => jsonRes(401, {}),
      [ASSOC_URL]: () => jsonRes(200, { device_udid: UDID, access_token: minted, refresh_token: 'r-new' }),
    });
    const changed = vi.fn();
    const minter = createTokenMinter(identity, WALLET, net, { now: () => nowMs, refreshToken: 'r-old', onDeviceChanged: changed });
    expect(await minter.getToken()).toBe(minted);
    expect(hits[RENEW_URL]).toBe(1);
    expect(hits[ASSOC_URL]).toBe(1);
    expect(minter.refreshToken()).toBe('r-new');
    expect(changed).not.toHaveBeenCalled(); // same device
  });

  it('does not re-associate when renew fails for lack of network', async () => {
    const net: SeFetch = async (url) => {
      if (url.startsWith(RENEW_URL)) throw new Error('offline');
      throw new Error(`unexpected ${url}`);
    };
    const minter = createTokenMinter(identity, WALLET, net, { refreshToken: 'r' });
    await expect(minter.getToken()).rejects.toMatchObject({ kind: 'network' });
  });

  it('reports a device the license re-bound to a NEW udid', async () => {
    const otherUdid = `U1.${TENANT}.hma101.${'EF'.repeat(32)}`;
    const { net } = routeNet({
      [ASSOC_URL]: () => jsonRes(200, { device_udid: otherUdid, access_token: fakeJwt(9e9), refresh_token: 'r' }),
    });
    const changed = vi.fn();
    const minter = createTokenMinter(identity, WALLET, net, { onDeviceChanged: changed });
    await minter.getToken();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ deviceUdid: otherUdid }));
  });

  it('invalidate() drops a cached token so the next call mints again', async () => {
    const nowMs = 1_000_000_000_000;
    const { net, hits } = routeNet({
      [ASSOC_URL]: () => jsonRes(200, { device_udid: UDID, access_token: fakeJwt(nowMs / 1000 + 12 * 3600), refresh_token: 'r' }),
    });
    const minter = createTokenMinter(identity, WALLET, net, { now: () => nowMs, seedToken: fakeJwt(nowMs / 1000 + 6 * 3600) });
    await minter.getToken();
    expect(hits[ASSOC_URL]).toBeUndefined();
    minter.invalidate();
    await minter.getToken();
    expect(hits[ASSOC_URL]).toBe(1);
  });
});

describe('withToken', () => {
  it('re-mints once when the API rejects the token', async () => {
    const tokens = ['old', 'new'];
    const minter = { getToken: vi.fn(async () => tokens[0]), invalidate: vi.fn(() => void tokens.shift()), refreshToken: () => undefined };
    const seen: string[] = [];
    const out = await withToken(minter, async (t) => {
      seen.push(t);
      if (t === 'old') throw new SeError('unauthorized', 'nope', 401);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(seen).toEqual(['old', 'new']);
    expect(minter.invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not retry other errors', async () => {
    const minter = { getToken: vi.fn(async () => 't'), invalidate: vi.fn(), refreshToken: () => undefined };
    await expect(withToken(minter, async () => Promise.reject(new SeError('http', 'boom', 500)))).rejects.toMatchObject({ kind: 'http' });
    expect(minter.invalidate).not.toHaveBeenCalled();
  });
});

describe('gatewaysToCatalog', () => {
  const gw = (ip: string, protocol: SeGateway['protocol'], locationKey: string): SeGateway => ({
    ip,
    protocol,
    countryCode: locationKey.slice(0, 2),
    locationKey,
    city: 'City',
    udpPorts: protocol === 'openvpn' ? [1194] : undefined,
  });

  it('keeps only openvpn gateways, grouped by location_key, deduped', () => {
    const cat = gatewaysToCatalog(
      [
        gw('1.1.1.1', 'openvpn', 'US-HI-HONOLULU'),
        gw('1.1.1.1', 'openvpn', 'US-HI-HONOLULU'), // dup
        gw('2.2.2.2', 'openvpn', 'US-OR-PORTLAND'),
        gw('9.9.9.9', 'wireguard', 'US-HI-HONOLULU'), // dropped
      ],
      1000,
    );
    const hi = cat.locations.find((l) => l.key === 'US-HI-HONOLULU')!;
    expect(hi.ips.map((e) => e.ip)).toEqual(['1.1.1.1']);
    expect(cat.locations.map((l) => l.key).sort()).toEqual(['US-HI-HONOLULU', 'US-OR-PORTLAND']);
  });
});

describe('discoverFeed', () => {
  it('discovers each key and merges openvpn IPs, tolerating a failed location', async () => {
    const minter = { getToken: vi.fn(async () => fakeJwt(9e9)), invalidate: vi.fn(), refreshToken: () => undefined };
    const net: SeFetch = async (url) => {
      if (url.includes('location_key=BAD')) return jsonRes(500, {});
      const key = new URL(url).searchParams.get('location_key');
      return jsonRes(200, {
        status: { code: 0 },
        data: {
          current_time: 1000,
          expires_at: 1120,
          ips: [{ ip: `10.0.0.${key === 'US' ? 1 : 2}`, protocol: 'openvpn', udp_ports: [1194], geo: { country_code: 'US', location_key: `${key}-CITY`, city: 'C' } }],
        },
      });
    };
    const cat = await discoverFeed(['US', 'BAD', 'JP'], minter, net, { tenant: TENANT, now: () => 2_000_000 });
    expect(cat.locations.map((l) => l.key).sort()).toEqual(['JP-CITY', 'US-CITY']);
    expect(cat.fetched).toBe(2000);
  });

  it('stops once the token is refused even after a re-mint, instead of hammering every location', async () => {
    const minter = { getToken: vi.fn(async () => 'jwt'), invalidate: vi.fn(), refreshToken: () => undefined };
    let discovers = 0;
    const net: SeFetch = async () => {
      discovers++;
      return jsonRes(401, {});
    };
    const cat = await discoverFeed(['US', 'JP', 'DE'], minter, net, { tenant: TENANT });
    expect(cat.locations).toHaveLength(0);
    expect(discovers).toBe(2); // US, then US again with a re-minted token, then stop
  });
});
