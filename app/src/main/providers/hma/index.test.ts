import { describe, expect, it } from 'vitest';
import { createHmaProvider } from './index';
import type { Account, AccountSecret, Catalog } from '../types';

const DUMMY_UDID = 'U1.00000000-0000-4000-8000-000000000000.hma201.deadbeefcafef00dfeedfacedeadbeefcafef00dfeedfacedeadbeefcafe0000';
const DUMMY_PASSWORD = '58a8079c210d5b3c2fba841e9edd4711e047b652fb09b983c9b5a9fddd0bead5';

const FAKE_CA_LINES = ['-----BEGIN CERTIFICATE-----', 'ZmFrZS1jZXJ0LWxpbmU=', '-----END CERTIFICATE-----'];

function fakeCatalog(): Catalog {
  return {
    fetched: 1000,
    locations: [
      {
        key: 'JP-40-TOKYO-ULT',
        country: 'JP',
        city: 'Tokyo',
        ips: [
          { ip: '203.0.113.10', firstSeen: 1000, lastOk: null },
          { ip: '203.0.113.11', firstSeen: 1000, lastOk: 1200 },
        ],
      },
    ],
  };
}

function makeProvider() {
  return createHmaProvider({ loadCatalog: async () => fakeCatalog(), caLines: FAKE_CA_LINES });
}

describe('hma provider: check', () => {
  it('accepts a well-formed udid + 64-hex password', () => {
    const provider = makeProvider();
    const result = provider.check({ udid: DUMMY_UDID, password: DUMMY_PASSWORD });
    expect(result.ok).toBe(true);
    expect(result.secret).toEqual({ kind: 'userpass', username: DUMMY_UDID, password: DUMMY_PASSWORD });
    expect(result.meta).toEqual({ udid: DUMMY_UDID });
  });

  it('rejects a udid without the U1. prefix', () => {
    const provider = makeProvider();
    const result = provider.check({ udid: 'bogus', password: DUMMY_PASSWORD });
    expect(result.ok).toBe(false);
    expect(result.reasonKey).toBeDefined();
  });

  it('rejects a password that is not 64 hex characters', () => {
    const provider = makeProvider();
    const result = provider.check({ udid: DUMMY_UDID, password: 'nothex' });
    expect(result.ok).toBe(false);
    expect(result.reasonKey).toBeDefined();
  });
});

describe('hma provider: targets', () => {
  it('reads catalog locations into Target[] with hma:-prefixed keys', async () => {
    const provider = makeProvider();
    const account: Account = { id: 'hma-1', providerId: 'hma', label: 'HMA', meta: {}, secretRef: 'hma-1' };
    const targets = await provider.targets(account);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: 'hma:JP-40-TOKYO-ULT',
      providerId: 'hma',
      country: 'JP',
      city: 'Tokyo',
      servers: ['203.0.113.10', '203.0.113.11'],
    });
  });
});

describe('hma provider: bind', () => {
  it('builds an OpenVpnEndpoint matching spec §5.1', () => {
    const provider = makeProvider();
    const account: Account = { id: 'hma-1', providerId: 'hma', label: 'HMA', meta: {}, secretRef: 'hma-1' };
    const secret: AccountSecret = { kind: 'userpass', username: DUMMY_UDID, password: DUMMY_PASSWORD };
    const target = { key: 'hma:JP-40-TOKYO-ULT', providerId: 'hma' as const, country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: ['203.0.113.10'] };

    const endpoint = provider.bind(target, '203.0.113.10', account, secret);

    expect(endpoint.type).toBe('openvpn-client');
    if (endpoint.type !== 'openvpn-client') throw new Error('unreachable');
    expect(endpoint.server).toBe('203.0.113.10');
    expect(endpoint.server_port).toBe(1194);
    expect(endpoint.network).toBe('udp');
    expect(endpoint.username).toBe(DUMMY_UDID);
    expect(endpoint.password).toBe(DUMMY_PASSWORD);
    expect(endpoint.tls.certificate).toEqual(FAKE_CA_LINES);
    expect(endpoint.tls.server_name).toBe('openvpn.gen-vpn.com');
    expect(endpoint.tls.remote_certificate_tls).toBe('server');
    expect(endpoint.data_ciphers).toEqual(['AES-256-GCM']);
    expect(endpoint.data_ciphers_fallback).toBe('AES-256-GCM');
    expect(endpoint.route_no_pull).toBe(true);
    expect(endpoint.explicit_exit_notify).toBe(2);
    expect(endpoint.mtu).toBe(1400);
  });

  it('rejects wrong server IP format at render-invariant level: server is always set, non-empty', () => {
    const provider = makeProvider();
    const account: Account = { id: 'hma-1', providerId: 'hma', label: 'HMA', meta: {}, secretRef: 'hma-1' };
    const secret: AccountSecret = { kind: 'userpass', username: DUMMY_UDID, password: DUMMY_PASSWORD };
    const target = { key: 'hma:JP-40-TOKYO-ULT', providerId: 'hma' as const, country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: ['203.0.113.11'] };
    const endpoint = provider.bind(target, '203.0.113.11', account, secret);
    if (endpoint.type !== 'openvpn-client') throw new Error('unreachable');
    expect(endpoint.server).toBeTruthy();
    expect(Array.isArray(endpoint.tls.certificate)).toBe(true);
    expect(endpoint.tls.certificate.length).toBeGreaterThan(0);
  });
});

describe('hma provider: real bundled CA', () => {
  it('loadCaLines default reads the committed Sectigo R46 PEM', async () => {
    const { loadCaLines } = await import('./ca');
    const lines = loadCaLines();
    expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(lines[lines.length - 1]).toBe('-----END CERTIFICATE-----');
    expect(lines.length).toBeGreaterThan(5);
  });
});
