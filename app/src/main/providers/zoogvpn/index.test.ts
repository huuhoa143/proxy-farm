import { describe, expect, it } from 'vitest';
import { createZoogvpnProvider } from './index';
import type { Account, AccountSecret } from '../types';
import type { ZoogServer } from './servers';

const FAKE_CA_LINES = ['-----BEGIN CERTIFICATE-----', 'ZmFrZS1jZXJ0', '-----END CERTIFICATE-----'];
const FAKE_TA_LINES = ['-----BEGIN OpenVPN Static key V1-----', 'ZmFrZS1rZXk=', '-----END OpenVPN Static key V1-----'];

function fakeServers(): ZoogServer[] {
  return [
    {
      key: 'JP-JP1',
      host: 'jp1.webunlim.com',
      country: 'JP',
      countryName: 'Japan',
      city: 'Japan',
      protos: { udp: 1194, tcp: 443 },
    },
  ];
}

function makeProvider() {
  return createZoogvpnProvider({
    loadServers: () => fakeServers(),
    caLines: FAKE_CA_LINES,
    tlsAuthLines: FAKE_TA_LINES,
  });
}

describe('zoogvpn provider: check', () => {
  it('accepts a non-empty username + password', () => {
    const provider = makeProvider();
    const result = provider.check({ username: 'user@example.com', password: 'hunter2' });
    expect(result.ok).toBe(true);
    expect(result.secret).toEqual({ kind: 'userpass', username: 'user@example.com', password: 'hunter2' });
  });

  it('rejects an empty username or password', () => {
    const provider = makeProvider();
    expect(provider.check({ username: '', password: 'x' }).ok).toBe(false);
    expect(provider.check({ username: 'x', password: '' }).ok).toBe(false);
  });
});

describe('zoogvpn provider: targets', () => {
  it('reads the bundled server list into Target[] with zoogvpn:-prefixed keys', async () => {
    const provider = makeProvider();
    const account: Account = { id: 'zoog-1', providerId: 'zoogvpn', label: 'Zoog', meta: {}, secretRef: 'zoog-1' };
    const targets = await provider.targets(account);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: 'zoogvpn:JP-JP1',
      providerId: 'zoogvpn',
      country: 'JP',
      servers: ['jp1.webunlim.com'],
    });
  });
});

describe('zoogvpn provider: bind', () => {
  it('builds an OpenVpnEndpoint with tls_auth control_wrap matching spec §5.2', () => {
    const provider = makeProvider();
    const account: Account = { id: 'zoog-1', providerId: 'zoogvpn', label: 'Zoog', meta: {}, secretRef: 'zoog-1' };
    const secret: AccountSecret = { kind: 'userpass', username: 'user@example.com', password: 'hunter2' };
    const target = { key: 'zoogvpn:JP-JP1', providerId: 'zoogvpn' as const, country: 'JP', city: 'Japan', label: 'Japan', servers: ['jp1.webunlim.com'] };

    const endpoint = provider.bind(target, '198.51.100.5', account, secret);

    expect(endpoint.type).toBe('openvpn-client');
    if (endpoint.type !== 'openvpn-client') throw new Error('unreachable');
    expect(endpoint.server).toBe('198.51.100.5');
    expect(endpoint.server_port).toBe(1194);
    expect(endpoint.network).toBe('udp');
    expect(endpoint.username).toBe('user@example.com');
    expect(endpoint.password).toBe('hunter2');
    expect(endpoint.auth).toBe('SHA256');
    expect(endpoint.data_ciphers).toEqual(['AES-256-GCM']);
    expect(endpoint.tls.certificate).toEqual(FAKE_CA_LINES);
    expect(endpoint.tls.remote_certificate_tls).toBe('server');
    expect(endpoint.tls.control_wrap).toEqual({ type: 'tls_auth', key: FAKE_TA_LINES, direction: 'client' });
    expect(endpoint.route_no_pull).toBe(true);
    expect(JSON.stringify(endpoint)).not.toMatch(/_path/);
  });
});

describe('zoogvpn provider: real bundled CA + tls-auth + servers', () => {
  it('default loaders read the committed resource files', async () => {
    const { loadCaLines, loadTlsAuthLines } = await import('./ca');
    const { loadServers } = await import('./servers');
    expect(loadCaLines()[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(loadTlsAuthLines()[0]).toBe('-----BEGIN OpenVPN Static key V1-----');
    const servers = loadServers();
    expect(servers.length).toBeGreaterThan(50);
  });
});
