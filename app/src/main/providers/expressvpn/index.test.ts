import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressvpnProvider, expressUserLabel } from './index';
import { loadProfile } from './profile';
import type { ExpressServer } from './servers';
import type { PoolNet } from '../surfshark/pool';
import type { Account, AccountSecret } from '../types';

const pem = (kind: string, body: string) => [`-----BEGIN ${kind}-----`, body, `-----END ${kind}-----`];
const FAKE_PROFILE = {
  caLines: pem('CERTIFICATE', 'ZmFrZS1jYQ=='),
  certLines: pem('CERTIFICATE', 'ZmFrZS1jZXJ0'),
  keyLines: pem('RSA PRIVATE KEY', 'ZmFrZS1rZXk='),
  tlsAuthLines: pem('OpenVPN Static key V1', 'ZmFrZS10YQ=='),
};

const SERVERS: ExpressServer[] = [
  { host: 'vietnam-ca-version-2.expressnetw.com', country: 'VN', countryName: 'Vietnam', city: '' },
  { host: 'usa-losangeles-2-ca-version-2.expressnetw.com', country: 'US', countryName: 'USA', city: 'Los Angeles' },
  { host: 'usa-losangeles-ca-version-2.expressnetw.com', country: 'US', countryName: 'USA', city: 'Los Angeles' },
];

/** Hermetic DNS: each hostname answers with its own fixed A records. */
function fakePoolNet(records: Record<string, string[]>): PoolNet {
  return {
    resolveSystem: async (host) => records[host] ?? [],
    resolveDoh: async () => [],
    sleep: async () => {},
  };
}

const ACCOUNT: Account = { id: 'expressvpn-1', providerId: 'expressvpn', label: 'user …abcdef', meta: {}, secretRef: 'expressvpn-1' };
const SECRET: AccountSecret = { kind: 'userpass', username: 'dummyuser0000000000abcdef', password: 'dummypass00000000000000000' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pf-expressvpn-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeProvider(records: Record<string, string[]> = {}) {
  return createExpressvpnProvider({
    poolPath: path.join(dir, 'expressvpn-pools.json'),
    loadServers: () => SERVERS,
    poolNet: fakePoolNet(records),
    profile: FAKE_PROFILE,
  });
}

describe('expressvpn provider: check', () => {
  it('accepts the manual-configuration username and password, labelled by the username’s tail', () => {
    const result = makeProvider().check({ username: ' dummyuser0000000000abcdef ', password: 'dummypass00000000000000000' });
    expect(result).toEqual({
      ok: true,
      label: 'user …abcdef',
      secret: { kind: 'userpass', username: 'dummyuser0000000000abcdef', password: 'dummypass00000000000000000' },
      meta: {},
    });
    expect(expressUserLabel('dummyuser0000000000abcdef')).toBe('user …abcdef');
  });

  it('asks for both fields', () => {
    expect(makeProvider().check({ username: '', password: 'x' })).toMatchObject({ ok: false, reasonKey: 'expressvpn.check.missingUsername' });
    expect(makeProvider().check({ username: 'x', password: '' })).toMatchObject({ ok: false, reasonKey: 'expressvpn.check.missingPassword' });
  });

  it('turns away an email address: the account login is not the OpenVPN username', () => {
    expect(makeProvider().check({ username: 'me@example.com', password: 'x' })).toMatchObject({ ok: false, reasonKey: 'expressvpn.check.notManualCredentials' });
  });

  it('turns away a credential over 128 bytes, which ExpressVPN servers refuse', () => {
    expect(makeProvider().check({ username: 'jwt-auth', password: 'x'.repeat(129) })).toMatchObject({ ok: false, reasonKey: 'expressvpn.check.tooLong' });
    expect(makeProvider().check({ username: 'u'.repeat(129), password: 'x' })).toMatchObject({ ok: false, reasonKey: 'expressvpn.check.tooLong' });
  });
});

describe('expressvpn provider: targets', () => {
  it('a location’s servers are the A records of its hostnames, as IP literals', async () => {
    const provider = makeProvider({
      'vietnam-ca-version-2.expressnetw.com': ['192.0.2.1', '192.0.2.2'],
      'usa-losangeles-2-ca-version-2.expressnetw.com': ['198.51.100.1'],
      'usa-losangeles-ca-version-2.expressnetw.com': ['198.51.100.2', '198.51.100.3'],
    });
    const targets = await provider.targets(ACCOUNT);
    expect(targets.map((t) => [t.key, t.servers])).toEqual([
      ['expressvpn:VN', ['192.0.2.1', '192.0.2.2']],
      ['expressvpn:US-LOS-ANGELES', ['198.51.100.1', '198.51.100.2', '198.51.100.3']],
    ]);
    for (const t of targets) expect(t.poolHostnames).toBe(true);
  });

  it('falls back to the hostnames while DNS has not answered', async () => {
    const targets = await makeProvider().targets(ACCOUNT);
    expect(targets[0].servers).toEqual(['vietnam-ca-version-2.expressnetw.com']);
    expect(targets[1].servers).toEqual(['usa-losangeles-2-ca-version-2.expressnetw.com', 'usa-losangeles-ca-version-2.expressnetw.com']);
  });

  it('has no free tier: every server takes every valid login', async () => {
    const provider = makeProvider();
    for (const t of await provider.targets(ACCOUNT)) expect(t.freeTierServers).toBeUndefined();
    expect(provider.anyServerChecksLogin).toBe(true);
  });
});

describe('expressvpn provider: bind', () => {
  it('builds the endpoint verified live against ExpressVPN (spec §5.6)', async () => {
    const provider = makeProvider();
    const [target] = await provider.targets(ACCOUNT);
    expect(provider.bind(target, '192.0.2.1', ACCOUNT, SECRET)).toEqual({
      type: 'openvpn-client',
      server: '192.0.2.1',
      server_port: 1195,
      network: 'udp',
      username: 'dummyuser0000000000abcdef',
      password: 'dummypass00000000000000000',
      tls: {
        server_name: 'Server',
        server_name_type: 'name-prefix',
        certificate: FAKE_PROFILE.caLines,
        client_certificate: FAKE_PROFILE.certLines,
        client_key: FAKE_PROFILE.keyLines,
        ns_certificate_type: 'server',
        control_wrap: { type: 'tls_auth', key: FAKE_PROFILE.tlsAuthLines, direction: 'client' },
      },
      data_ciphers: ['AES-256-GCM'],
      auth: 'SHA512',
      fragment: 1300,
      mss_fix: 1200,
      compression_lzo: 'no',
      route_no_pull: true,
      mtu: 1500,
    });
  });

  it('refuses any secret but a username/password', async () => {
    const provider = makeProvider();
    const [target] = await provider.targets(ACCOUNT);
    expect(() => provider.bind(target, '192.0.2.1', ACCOUNT, { kind: 'wgkey', privateKey: 'x' })).toThrow(/userpass/);
  });
});

describe('expressvpn provider: the bundled shared profile', () => {
  it('loads the CA, client certificate, client key and tls-auth key as bare PEM blocks', () => {
    const profile = loadProfile();
    expect(profile.caLines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(profile.caLines.filter((l) => l.startsWith('-----BEGIN'))).toHaveLength(1);
    expect(profile.certLines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(profile.keyLines[0]).toBe('-----BEGIN RSA PRIVATE KEY-----');
    expect(profile.tlsAuthLines[0]).toBe('-----BEGIN OpenVPN Static key V1-----');
    expect(profile.tlsAuthLines.at(-1)).toBe('-----END OpenVPN Static key V1-----');
  });
});
