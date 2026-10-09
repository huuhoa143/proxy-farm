import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Account, AccountSecret, WireguardEndpoint } from '../types';
import { renderConfig } from '../../engine/render-config';
import { assertConfigInvariants } from '../../engine/invariants';
import { createNordvpnProvider, NORDLYNX_ADDRESS } from './index';
import { CREDENTIALS_URL } from './credentials';
import { wgKeyLabel } from '../wg-key';
import { SERVERS_URL, type FetchLike } from './servers';
import { PK_HANOI, PK_HCMC, samplePayload } from './fixtures/sample-servers';

// Dummy values of the right shape, not real credentials.
const TOKEN = 'ef'.repeat(32);
const KEY = 'kNWOz8Z0Ft2V0vHn8bU1Hc0w2m9yBq7Ri3sXkQe1hGc=';
const SECRET: AccountSecret = { kind: 'wgkey', privateKey: KEY };
const ACCOUNT: Account = { id: 'nordvpn-1', providerId: 'nordvpn', label: 'key …1hGc=', meta: {}, secretRef: 'account:nordvpn-1' };

let dir: string;
let cachePath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pf-nordvpn-'));
  cachePath = path.join(dir, 'cache', 'nordvpn-servers.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Hermetic Nord API: the server list, and the credentials endpoint answering `creds`. */
function fakeNord(creds: { status: number; body?: unknown } = { status: 200, body: { nordlynx_private_key: KEY } }) {
  return vi.fn<FetchLike>(async (url) => {
    if (url === SERVERS_URL) return { ok: true, status: 200, json: async () => samplePayload() };
    if (url === CREDENTIALS_URL) return { ok: creds.status === 200, status: creds.status, json: async () => creds.body };
    throw new Error(`unexpected URL ${url}`);
  });
}

describe('nordvpn provider: adding an account', () => {
  it('check() accepts a NordLynx private key and stores it as a wgkey secret, labelled by its PUBLIC key', () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord() });
    expect(provider.check({ credential: ` ${KEY}\n` })).toEqual({ ok: true, label: wgKeyLabel(KEY), secret: SECRET, meta: {} });
    expect(provider.check({ privateKey: KEY }).ok).toBe(true);
  });

  it('check() refuses malformed input, and a token it was not given the chance to exchange', () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord() });
    for (const bad of ['', 'hello', KEY.slice(1), `${TOKEN}0`, 'g'.repeat(64)]) {
      expect(provider.check({ credential: bad })).toEqual({ ok: false, reasonKey: 'nordvpn.check.invalidInput' });
    }
    expect(provider.check({ credential: TOKEN }).ok).toBe(false);
  });

  it('resolveInput() exchanges an access token for the NordLynx key with one call', async () => {
    const fetchImpl = fakeNord();
    const provider = createNordvpnProvider({ cachePath, fetchImpl });
    const resolved = await provider.resolveInput!({ credential: TOKEN });
    expect(resolved).toEqual({ input: { privateKey: KEY } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.check((resolved as { input: Record<string, string> }).input)).toMatchObject({ ok: true, secret: SECRET });
  });

  it('resolveInput() passes a key (or anything that is not a token) through without a network call', async () => {
    const fetchImpl = fakeNord();
    const provider = createNordvpnProvider({ cachePath, fetchImpl });
    expect(await provider.resolveInput!({ credential: KEY })).toEqual({ input: { credential: KEY } });
    expect(await provider.resolveInput!({ credential: 'junk' })).toEqual({ input: { credential: 'junk' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolveInput() reports a refused token', async () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord({ status: 401, body: {} }) });
    expect(await provider.resolveInput!({ credential: TOKEN })).toEqual({ reasonKey: 'nordvpn.check.tokenRejected' });
  });
});

describe('nordvpn provider: targets', () => {
  it('one location per (country, city), stable keys, servers = station IPs least loaded first', async () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord() });
    const targets = await provider.targets(ACCOUNT);
    expect(targets.map((t) => t.key)).toEqual(['nordvpn:BR-SAO-PAULO', 'nordvpn:VN-HANOI', 'nordvpn:VN-HO-CHI-MINH-CITY']);
    expect(targets[1]).toEqual({
      key: 'nordvpn:VN-HANOI',
      providerId: 'nordvpn',
      country: 'VN',
      city: 'Hanoi',
      label: 'Vietnam — Hanoi',
      servers: ['192.0.2.1', '192.0.2.3'],
      virtualLocation: true,
    });
    expect(targets[2].servers).toEqual(['198.51.100.45', '198.51.100.111', '198.51.100.67']);
    expect(targets[0].virtualLocation).toBeUndefined(); // São Paulo is not marked
  });

  it('concurrent calls (one per account) share a single fetch, and the cache serves the next ones', async () => {
    const fetchImpl = fakeNord();
    const provider = createNordvpnProvider({ cachePath, fetchImpl });
    await Promise.all([provider.targets(ACCOUNT), provider.targets({ ...ACCOUNT, id: 'nordvpn-2' })]);
    await provider.targets(ACCOUNT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('nordvpn provider: bind', () => {
  it('a NordLynx WireGuard endpoint to the pinned server with that server\'s own public key', async () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord() });
    const [, hanoi, hcmc] = await provider.targets(ACCOUNT);
    expect(provider.bind(hanoi, '192.0.2.3', ACCOUNT, SECRET)).toEqual({
      type: 'wireguard',
      address: [NORDLYNX_ADDRESS],
      private_key: KEY,
      mtu: 1280,
      peers: [{ address: '192.0.2.3', port: 51820, public_key: PK_HANOI, allowed_ips: ['0.0.0.0/0'], persistent_keepalive_interval: 25 }],
    });
    expect(NORDLYNX_ADDRESS).toBe('10.5.0.2/32');
    expect((provider.bind(hcmc, '198.51.100.67', ACCOUNT, SECRET) as WireguardEndpoint).peers[0].public_key).toBe(PK_HCMC);
  });

  it('is deterministic from the disk cache alone: a fresh instance binds without targets()', async () => {
    await createNordvpnProvider({ cachePath, fetchImpl: fakeNord() }).targets(ACCOUNT);
    const fetchImpl = fakeNord();
    const fresh = createNordvpnProvider({ cachePath, fetchImpl });
    const target = { key: 'nordvpn:VN-HANOI', providerId: 'nordvpn' as const, country: 'VN', city: 'Hanoi', label: '', servers: ['192.0.2.1'] };
    expect((fresh.bind(target, '192.0.2.1', ACCOUNT, SECRET) as WireguardEndpoint).peers[0]).toMatchObject({ address: '192.0.2.1', public_key: PK_HANOI });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a clear error for an unknown server or without a cache, and for a non-wgkey secret', async () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord() });
    const target = { key: 'nordvpn:VN-HANOI', providerId: 'nordvpn' as const, country: 'VN', city: 'Hanoi', label: '', servers: [] };
    expect(() => provider.bind(target, '192.0.2.1', ACCOUNT, SECRET)).toThrow(/refresh the server list/);
    await provider.targets(ACCOUNT);
    expect(() => provider.bind(target, '192.0.2.200', ACCOUNT, SECRET)).toThrow(/no cached server/);
    expect(() => provider.bind(target, '192.0.2.1', ACCOUNT, { kind: 'userpass', username: 'u', password: 'p' })).toThrow(/wgkey/);
  });

  it('renders to a config that passes the engine invariants', async () => {
    const provider = createNordvpnProvider({ cachePath, fetchImpl: fakeNord() });
    const [, hanoi] = await provider.targets(ACCOUNT);
    const endpoint = provider.bind(hanoi, hanoi.servers[0], ACCOUNT, SECRET);
    const text = renderConfig({ endpoint, listen: { host: '127.0.0.1', port: 29001 }, clash: { port: 40001, secret: 's' } });
    expect(() => assertConfigInvariants(JSON.parse(text))).not.toThrow();
  });
});
