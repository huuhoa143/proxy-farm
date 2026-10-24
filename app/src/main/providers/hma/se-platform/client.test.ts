import { describe, expect, it } from 'vitest';
import {
  associateLicense,
  discover,
  fetchDeviceCredentials,
  fetchGeos,
  fetchLicense,
  renewToken,
  SeError,
  tenantOfUdid,
} from './client';
import type { SeFetch, SeResponse } from './types';

// Fixtures mirror the real API shapes (reverse-engineered) with fake secret values.
const TENANT = '11111111-2222-3333-4444-555555555555';
const UDID = `U1.${TENANT}.hma101.${'AB'.repeat(32)}`;
const WALLET = 'TEST00-TEST11-TEST22';

function jsonRes(status: number, body: unknown): SeResponse {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Builds a fake SeFetch from a url→response map, recording the calls it sees. */
function fakeNet(routes: Record<string, (init: Parameters<SeFetch>[1]) => SeResponse>): {
  net: SeFetch;
  calls: Array<{ url: string; init: Parameters<SeFetch>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<SeFetch>[1] }> = [];
  const net: SeFetch = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`no fake route for ${url}`);
    return routes[key](init);
  };
  return { net, calls };
}

describe('tenantOfUdid', () => {
  it('extracts the tenant GUID from a device udid', () => {
    expect(tenantOfUdid(UDID)).toBe(TENANT);
  });
  it('returns undefined for a malformed udid', () => {
    expect(tenantOfUdid('not-a-udid')).toBeUndefined();
  });
});

describe('fetchLicense', () => {
  const route = 'https://my-win.avast.com/v1/query/get-exact-application-licenses';

  it('returns the license whose id is the container_id', async () => {
    const { net, calls } = fakeNet({
      [route]: () => jsonRes(200, [{ id: 'container-xyz', walletKeys: [WALLET], expires: 1796486935626, mode: 'PAID' }]),
    });
    const lic = await fetchLicense(WALLET, 'fp-hex', net);
    expect(lic.id).toBe('container-xyz');
    expect(lic.walletKeys).toContain(WALLET);
    // sends the walletKey in the body and the fingerprint as the Vaar device id
    const body = JSON.parse(calls[0].init!.body!);
    expect(body).toEqual({ walletKeys: [WALLET] });
    expect(calls[0].init!.headers!['Vaar-Header-Device-Id']).toBe('fp-hex');
    // like the app: Vaar headers only, no Content-Type
    expect(calls[0].init!.headers!['Content-Type']).toBeUndefined();
  });

  it('throws noLicense when the wallet key matches nothing', async () => {
    const { net } = fakeNet({ [route]: () => jsonRes(200, []) });
    await expect(fetchLicense(WALLET, 'fp', net)).rejects.toMatchObject({ kind: 'noLicense' });
  });
});

describe('associateLicense', () => {
  const route = 'https://api.se-platform.com/aladdin/v1/authorization/associate-license';

  it('mints the device token and sends container_id/device_fingerprint/wallet_key', async () => {
    const { net, calls } = fakeNet({
      [route]: () => jsonRes(200, { device_udid: UDID, access_token: 'jwt-abc', refresh_token: 'refresh-abc' }),
    });
    const tok = await associateLicense(
      { containerId: 'container-xyz', deviceFingerprint: 'fp-hex', walletKey: WALLET, tenantId: TENANT },
      net,
    );
    expect(tok).toEqual({ deviceUdid: UDID, accessToken: 'jwt-abc', refreshToken: 'refresh-abc' });
    const body = JSON.parse(calls[0].init!.body!);
    expect(body).toEqual({ container_id: 'containerxyz', device_fingerprint: 'fp-hex', wallet_key: WALLET });
    expect(calls[0].init!.headers!['SE-Client-API-Key']).toBeTruthy();
    expect(calls[0].init!.headers!['X-NLok-Tenant-ID']).toBe(TENANT);
    // associate-license carries no Authorization header, but the full client identity
    expect(calls[0].init!.headers!.Authorization).toBeUndefined();
    expect(calls[0].init!.headers!['SE-Platform-ID']).toBe('win-x86-64');
    expect(calls[0].init!.headers!['SE-Client-Locale']).toBe('en-US');
  });

  it('strips the dashes from the license id, like the app', async () => {
    const { net, calls } = fakeNet({
      [route]: () => jsonRes(200, { device_udid: UDID, access_token: 'a', refresh_token: 'r' }),
    });
    await associateLicense({ containerId: 'cba31cd9-3f1c-4e75', deviceFingerprint: 'f', walletKey: WALLET, tenantId: TENANT }, net);
    expect(JSON.parse(calls[0].init!.body!).container_id).toBe('cba31cd93f1c4e75');
  });

  it('maps 401 to unauthorized', async () => {
    const { net } = fakeNet({ [route]: () => jsonRes(401, {}) });
    await expect(
      associateLicense({ containerId: 'c', deviceFingerprint: 'f', walletKey: WALLET, tenantId: TENANT }, net),
    ).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });
});

describe('fetchDeviceCredentials', () => {
  const route = 'https://api.se-platform.com/passage/v6/devices/';

  it('returns the OpenVPN password and CA from the envelope', async () => {
    const { net, calls } = fakeNet({
      [route]: () =>
        jsonRes(200, {
          status: { code: 0, message: 'success' },
          data: {
            credentials: {
              device_udid: UDID,
              device_password: 'DEAD'.repeat(16),
              openvpn_ca_certificate: '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----',
              certificate: 'MIIbase64p12',
              certificate_password: 'cert-pass',
            },
          },
        }),
    });
    const cred = await fetchDeviceCredentials({ deviceUdid: UDID, tenantId: TENANT, token: 'jwt-abc' }, net);
    expect(cred.devicePassword).toBe('DEAD'.repeat(16));
    expect(cred.openvpnCaCertificate).toContain('BEGIN CERTIFICATE');
    expect(cred.certificate).toBe('MIIbase64p12');
    // PUT with a Bearer token and a null body, udid in the path
    expect(calls[0].init!.method).toBe('PUT');
    expect(calls[0].init!.body).toBe('null');
    expect(calls[0].init!.headers!.Authorization).toBe('Bearer jwt-abc');
    expect(calls[0].url).toContain(encodeURIComponent(UDID));
    // the bare client identity, as the app sends it on passage
    expect(calls[0].init!.headers!['SE-Platform-ID']).toBeUndefined();
    expect(calls[0].init!.headers!['SE-Client-Locale']).toBeUndefined();
  });
});

describe('renewToken', () => {
  const route = 'https://api.se-platform.com/elysium/v1/renew';

  it('POSTs the refresh token with Basic nsv:<udid> and returns the next pair', async () => {
    const { net, calls } = fakeNet({ [route]: () => jsonRes(200, { access_token: 'jwt-2', refresh_token: 'refresh-2' }) });
    const tokens = await renewToken({ deviceUdid: UDID, refreshToken: 'refresh-1', tenantId: TENANT }, net);
    expect(tokens).toEqual({ accessToken: 'jwt-2', refreshToken: 'refresh-2' });
    expect(calls[0].init!.method).toBe('POST');
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1' });
    const auth = calls[0].init!.headers!.Authorization;
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice(6), 'base64').toString('utf8')).toBe(`nsv:${UDID}`);
  });

  it('maps 410 to gone (device removed from the license)', async () => {
    const { net } = fakeNet({ [route]: () => jsonRes(410, {}) });
    await expect(renewToken({ deviceUdid: UDID, refreshToken: 'r', tenantId: TENANT }, net)).rejects.toMatchObject({ kind: 'gone' });
  });
});

describe('fetchGeos', () => {
  const route = 'https://api.se-platform.com/discovery/v12/geos';

  it('flattens countries and their cities, dropping inactive ones', async () => {
    const { net, calls } = fakeNet({
      [route]: () =>
        jsonRes(200, {
          status: { code: 0 },
          data: {
            geos: [
              {
                location_key: 'US',
                country_code: 'US',
                country: 'United States',
                state: 'active',
                cities: [
                  { location_key: 'US-HI-HONOLULU', location_city: 'Honolulu', state: 'active' },
                  { location_key: 'US-XX-GONE', location_city: 'Gone', state: 'inactive' },
                ],
              },
              { location_key: 'ZZ', country_code: 'ZZ', country: 'Nowhere', state: 'inactive', cities: [] },
            ],
          },
        }),
    });
    const geos = await fetchGeos({ tenantId: TENANT }, net);
    // the app fetches geos without a token
    expect(calls[0].init!.headers!.Authorization).toBeUndefined();
    expect(calls[0].init!.headers!['SE-Client-Locale']).toBe('en-US');
    expect(geos.map((g) => g.locationKey)).toEqual(['US']); // inactive country ZZ dropped
    const us = geos[0];
    expect(us.countryName).toBe('United States');
    expect(us.cities.find((c) => c.locationKey === 'US-HI-HONOLULU')?.active).toBe(true);
    expect(us.cities.find((c) => c.locationKey === 'US-XX-GONE')?.active).toBe(false);
  });
});

describe('discover', () => {
  const route = 'https://api.se-platform.com/discovery/v9/discover';

  it('parses gateways with their protocol and ports', async () => {
    const { net, calls } = fakeNet({
      [route]: () =>
        jsonRes(200, {
          status: { code: 0 },
          data: {
            current_time: 1792775155,
            expires_at: 1792775275,
            ips: [
              { ip: '15.220.1.219', protocol: 'openvpn', ports: [443], udp_ports: [1194], geo: { country_code: 'US', location_key: 'US-OR-PORTLAND', city: 'Portland' } },
              { ip: '96.0.161.213', protocol: 'wireguard', geo: { country_code: 'US', location_key: 'US-HI-HONOLULU', city: 'Honolulu' } },
            ],
          },
        }),
    });
    const result = await discover({ locationKey: 'US', tenantId: TENANT, token: 'jwt' }, net);
    expect(result.expiresAt - result.currentTime).toBe(120);
    expect(result.gateways).toHaveLength(2);
    const ovpn = result.gateways.find((g) => g.protocol === 'openvpn')!;
    expect(ovpn.ip).toBe('15.220.1.219');
    expect(ovpn.udpPorts).toEqual([1194]);
    expect(ovpn.locationKey).toBe('US-OR-PORTLAND');
    expect(calls[0].url).toContain('location_key=US');
    expect(calls[0].init!.headers!.Authorization).toBe('Bearer jwt');
    expect(calls[0].init!.headers!['Content-Type']).toBe('application/json; charset=utf-8');
    expect(calls[0].init!.headers!['SE-Operating-System-Type']).toBeUndefined();
  });

  it('maps a non-zero status code to badResponse', async () => {
    const { net } = fakeNet({ [route]: () => jsonRes(200, { status: { code: 5, message: 'nope' }, data: {} }) });
    await expect(discover({ locationKey: 'US', tenantId: TENANT, token: 'jwt' }, net)).rejects.toMatchObject({
      kind: 'badResponse',
    });
  });
});

describe('SeError', () => {
  it('carries a stable kind', () => {
    expect(new SeError('network', 'x').kind).toBe('network');
  });
});
