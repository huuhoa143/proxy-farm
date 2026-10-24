import { describe, expect, it, vi } from 'vitest';
import {
  createTokenMinter,
  identityFromMeta,
  identityToMeta,
  newDeviceFingerprint,
  registerDevice,
  type DeviceIdentity,
} from './device';
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

  it('generates a fingerprint + tenant when none given', async () => {
    const { net } = routeNet({
      [LICENSE_URL]: () => jsonRes(200, [{ id: 'c', walletKeys: [WALLET] }]),
      [ASSOC_URL]: () => jsonRes(200, { device_udid: UDID, access_token: fakeJwt(9e9), refresh_token: 'r' }),
      [PASSAGE_URL]: () =>
        jsonRes(200, { status: { code: 0 }, data: { credentials: { device_udid: UDID, device_password: 'p', openvpn_ca_certificate: 'ca' } } }),
    });
    const dev = await registerDevice(WALLET, net);
    expect(dev.identity.deviceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(dev.identity.tenant).toBe(TENANT); // from the returned udid, not the random seed
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
    };
    const meta = identityToMeta(id);
    expect(meta.source).toBe('se-platform');
    expect(meta.walletKey).toBeUndefined(); // the license key is never written to meta
    expect(identityFromMeta(meta)).toEqual(id);
  });
  it('rejects meta from another source or missing fields', () => {
    expect(identityFromMeta({ source: 'local' })).toBeUndefined();
    expect(identityFromMeta({ source: 'se-platform', deviceFingerprint: 'fp' })).toBeUndefined();
  });
});

describe('createTokenMinter', () => {
  const identity = { deviceFingerprint: 'fp', tenant: TENANT, containerId: 'c' };

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
    const minter = createTokenMinter(identity, WALLET, net, { now: () => nowMs, seedToken: fakeJwt(nowMs / 1000 + 10 * 60) });
    const t = await minter.getToken();
    expect(t).toBe(fresh);
    expect(hits[ASSOC_URL]).toBe(1);
    // second call now fresh → no extra mint
    await minter.getToken();
    expect(hits[ASSOC_URL]).toBe(1);
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
    const minter = { getToken: vi.fn(async () => fakeJwt(9e9)) };
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
});
