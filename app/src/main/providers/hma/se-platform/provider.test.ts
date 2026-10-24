import { describe, expect, it, vi } from 'vitest';
import { createHmaProvider } from '../index';
import type { SeCatalogStore } from './catalog-store';
import type { Account } from '../../types';
import type { SeFetch, SeGeoCountry, SeResponse } from './types';

const TENANT = '11111111-2222-3333-4444-555555555555';
const UDID = `U1.${TENANT}.hma101.${'AB'.repeat(32)}`;
const WALLET = 'TEST00-TEST11-TEST22';

function jsonRes(status: number, body: unknown): SeResponse {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
function fakeJwt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSec, sub: UDID })}.sig`;
}

function registrationNet(): SeFetch {
  return async (url) => {
    if (url.includes('get-exact-application-licenses')) return jsonRes(200, [{ id: 'container-1', walletKeys: [WALLET] }]);
    if (url.includes('associate-license')) return jsonRes(200, { device_udid: UDID, access_token: fakeJwt(9e9), refresh_token: 'r' });
    if (url.includes('/credentials'))
      return jsonRes(200, {
        status: { code: 0 },
        data: { credentials: { device_udid: UDID, device_password: 'CD'.repeat(32), openvpn_ca_certificate: 'CA-LINE-1\nCA-LINE-2' } },
      });
    throw new Error(`unexpected ${url}`);
  };
}

const fakeGeos: SeGeoCountry[] = [
  { locationKey: 'US', countryCode: 'US', countryName: 'United States', active: true, cities: [{ locationKey: 'US-HI-HONOLULU', city: 'Honolulu', active: true }] },
];

function fakeStore() {
  return {
    geos: vi.fn(async () => fakeGeos),
    snapshot: () => ({
      fetched: 1000,
      locations: [{ key: 'US-HI-HONOLULU', country: 'US', city: 'Honolulu', ips: [{ ip: '96.0.161.172', firstSeen: 1000, lastOk: 2000 }] }],
    }),
    refreshOne: vi.fn(async () => undefined),
  } satisfies SeCatalogStore;
}

function seAccount(): Account {
  return {
    id: 'hma-1',
    providerId: 'hma',
    label: 'device …1BE93',
    secretRef: 'account:hma-1',
    meta: {
      source: 'se-platform',
      deviceFingerprint: 'fp',
      tenant: TENANT,
      containerId: 'container-1',
      deviceUdid: UDID,
      openvpnCa: 'CA-LINE-1\nCA-LINE-2',
    },
  };
}

/** A store whose refreshOne really discovers through the minter (to exercise token minting). */
function createSeStoreThatDiscovers(net: SeFetch): SeCatalogStore {
  return {
    geos: async () => fakeGeos,
    snapshot: () => ({ fetched: 0, locations: [] }),
    async refreshOne(ctx, locationKey) {
      const token = await ctx.minter.getToken();
      await net(`https://api.se-platform.com/discovery/v9/discover?location_key=${locationKey}`, { headers: { Authorization: `Bearer ${token}` } });
    },
  };
}

describe('HMA provider — se-platform path', () => {
  it('resolveInput registers a device and returns udid + password + identity meta', async () => {
    const provider = createHmaProvider({ sePlatform: { net: registrationNet(), store: fakeStore() } });
    const resolved = await provider.resolveInput!({ licenseKey: WALLET });
    expect('input' in resolved).toBe(true);
    const input = (resolved as { input: Record<string, string> }).input;
    expect(input.udid).toBe(UDID);
    expect(input.password).toBe('CD'.repeat(32));
    expect(input.source).toBe('se-platform');
    expect(input.walletKey).toBe(WALLET);
    expect(input.refreshToken).toBe('r');
    expect(Number(input.credsAt)).toBeGreaterThan(0);

    // check() turns it into a userpass secret + se-platform meta
    const check = provider.check(input);
    expect(check.ok).toBe(true);
    // The license key goes into the encrypted secret, never into meta.
    expect(check.secret).toEqual({ kind: 'userpass', username: UDID, password: 'CD'.repeat(32), walletKey: WALLET, refreshToken: 'r' });
    expect(check.meta?.source).toBe('se-platform');
    expect(check.meta?.walletKey).toBeUndefined();
    expect(check.meta?.licenseHint).toContain(WALLET.slice(-4));
    expect(check.meta?.openvpnCa).toContain('CA-LINE-1');
    expect(check.meta?.refreshToken).toBeUndefined(); // a credential: secret only
    expect(check.meta?.credsAt).toBe(input.credsAt);
  });

  it('resolveInput without se-platform deps refuses with a reason key', async () => {
    const provider = createHmaProvider();
    const resolved = await provider.resolveInput!({ licenseKey: WALLET });
    expect(resolved).toEqual({ reasonKey: 'hma.sePlatform.unavailable' });
  });

  it('targets() builds locations from geos names + cached IPs, discovering nothing', async () => {
    const store = fakeStore();
    const provider = createHmaProvider({ sePlatform: { net: registrationNet(), store, loadWalletKey: () => WALLET } });
    const targets = await provider.targets(seAccount());
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: 'hma:US-HI-HONOLULU',
      providerId: 'hma',
      country: 'US',
      city: 'Honolulu',
      label: 'United States — Honolulu',
      servers: ['96.0.161.172'],
    });
    expect(store.refreshOne).not.toHaveBeenCalled(); // discovery is on demand only
  });

  it('refreshAll() re-fetches the location list instead of sweeping every country', async () => {
    const store = fakeStore();
    const provider = createHmaProvider({ sePlatform: { net: registrationNet(), store, loadWalletKey: () => WALLET } });
    await provider.refreshAll!(seAccount());
    expect(store.geos).toHaveBeenCalledWith({ tenant: TENANT }, { force: true });
    expect(store.refreshOne).not.toHaveBeenCalled();
  });

  it('refreshCredentials() keeps the license + refresh token in the secret and stamps credsAt', async () => {
    const saved: string[] = [];
    const net: SeFetch = async (url) => {
      if (url.includes('elysium/v1/renew')) return jsonRes(200, { access_token: fakeJwt(9e9), refresh_token: 'r2' });
      return registrationNet()(url);
    };
    const provider = createHmaProvider({
      sePlatform: {
        net,
        store: fakeStore(),
        now: () => 5_000,
        loadWalletKey: () => WALLET,
        loadRefreshToken: () => 'r1',
        saveRefreshToken: (_a, t) => saved.push(t),
      },
    });
    const refreshed = await provider.refreshCredentials!(seAccount());
    expect(refreshed?.secret).toEqual({ kind: 'userpass', username: UDID, password: 'CD'.repeat(32), walletKey: WALLET, refreshToken: 'r2' });
    expect(refreshed?.meta?.credsAt).toBe('5000');
    expect(saved).toEqual(['r2']); // the rotated refresh token was persisted at once
  });

  it('a license re-bound to a new device hands the account replacement credentials', async () => {
    const NEW_UDID = `U1.${TENANT}.hma101.${'EF'.repeat(32)}`;
    const net: SeFetch = async (url) => {
      if (url.includes('associate-license')) return jsonRes(200, { device_udid: NEW_UDID, access_token: fakeJwt(9e9), refresh_token: 'rn' });
      if (url.includes('/credentials'))
        return jsonRes(200, {
          status: { code: 0 },
          data: { credentials: { device_udid: NEW_UDID, device_password: 'EE'.repeat(32), openvpn_ca_certificate: 'CA-NEW' } },
        });
      if (url.includes('/discover')) return jsonRes(200, { status: { code: 0 }, data: { ips: [] } });
      throw new Error(`unexpected ${url}`);
    };
    const replaced = vi.fn();
    const store = createSeStoreThatDiscovers(net);
    const provider = createHmaProvider({ sePlatform: { net, store, loadWalletKey: () => WALLET, onCredentialsReplaced: replaced } });
    await provider.refreshLocation!(seAccount(), 'hma:US-HI-HONOLULU');
    await vi.waitFor(() => expect(replaced).toHaveBeenCalled());
    const update = replaced.mock.calls[0][1];
    expect(update.secret).toMatchObject({ username: NEW_UDID, password: 'EE'.repeat(32), walletKey: WALLET, refreshToken: 'rn' });
    expect(update.meta).toMatchObject({ deviceUdid: NEW_UDID, openvpnCa: 'CA-NEW' });
  });

  it('bind() uses the device CA from account.meta, udp/1194, server CN', () => {
    const provider = createHmaProvider({ sePlatform: { net: registrationNet(), store: fakeStore() } });
    const account = seAccount();
    const ep = provider.bind(
      { key: 'hma:US-HI-HONOLULU', providerId: 'hma', country: 'US', city: 'Honolulu', label: 'x', servers: ['96.0.161.172'] },
      '96.0.161.172',
      account,
      { kind: 'userpass', username: UDID, password: 'CD'.repeat(32) },
    );
    expect(ep.type).toBe('openvpn-client');
    if (ep.type !== 'openvpn-client') throw new Error('wrong endpoint');
    expect(ep.server).toBe('96.0.161.172');
    expect(ep.server_port).toBe(1194);
    expect(ep.network).toBe('udp');
    expect(ep.username).toBe(UDID);
    expect(ep.tls.certificate).toEqual(['CA-LINE-1', 'CA-LINE-2']); // device CA, split to lines
    expect(ep.tls.server_name).toBe('openvpn.gen-vpn.com');
  });
});
