import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileProvider } from './index';
import type { Account, AccountSecret } from '../types';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GOOD_OVPN = readFileSync(path.join(FIXTURES, 'good.ovpn'), 'utf8');
const BAD_OVPN = readFileSync(path.join(FIXTURES, 'bad-unsupported-directive.ovpn'), 'utf8');
const GOOD_CONF = readFileSync(path.join(FIXTURES, 'good.conf'), 'utf8');
const BAD_CONF = readFileSync(path.join(FIXTURES, 'bad-unsupported-directive.conf'), 'utf8');

describe('file provider: check — .ovpn', () => {
  it('accepts a good .ovpn needing credentials, once credentials are supplied', () => {
    const withoutCreds = fileProvider.check({ name: 'vpn.ovpn', content: GOOD_OVPN });
    expect(withoutCreds.ok).toBe(false);
    expect(withoutCreds.reasonKey).toBe('file.check.needsCredentials');

    const withCreds = fileProvider.check({ name: 'vpn.ovpn', content: GOOD_OVPN, username: 'me', password: 'pw' });
    expect(withCreds.ok).toBe(true);
    expect(withCreds.meta).toMatchObject({ format: 'openvpn', host: 'vpn.example.net', port: '1194' });
    expect(withCreds.secret).toMatchObject({ kind: 'file', username: 'me', password: 'pw' });
  });

  it('rejects an unsupported-directive .ovpn with the i18n key', () => {
    const result = fileProvider.check({ name: 'bad.ovpn', content: BAD_OVPN, username: 'me', password: 'pw' });
    expect(result.ok).toBe(false);
    expect(result.reasonKey).toBe('file.unsupportedDirective');
  });
});

describe('file provider: check — .conf (WireGuard)', () => {
  it('accepts a good .conf with no credentials needed', () => {
    const result = fileProvider.check({ name: 'vpn.conf', content: GOOD_CONF });
    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({ format: 'wireguard', host: 'vpn.example.net', port: '51820' });
  });

  it('rejects an unsupported-directive .conf with the i18n key', () => {
    const result = fileProvider.check({ name: 'bad.conf', content: BAD_CONF });
    expect(result.ok).toBe(false);
    expect(result.reasonKey).toBe('file.unsupportedDirective');
  });
});

describe('file provider: targets + bind round trip', () => {
  it('.ovpn: targets() + bind() produce a valid OpenVpnEndpoint with no *_path fields', async () => {
    const checked = fileProvider.check({ name: 'vpn.ovpn', content: GOOD_OVPN, username: 'me', password: 'pw' });
    expect(checked.ok).toBe(true);
    const account: Account = {
      id: 'file-1',
      providerId: 'file',
      label: 'Imported',
      meta: checked.meta!,
      secretRef: 'file-1',
    };
    const targets = await fileProvider.targets(account);
    expect(targets).toHaveLength(1);
    expect(targets[0].servers).toEqual(['vpn.example.net']);

    const endpoint = fileProvider.bind(targets[0], '203.0.113.9', account, checked.secret as AccountSecret);
    expect(endpoint.type).toBe('openvpn-client');
    expect((endpoint as any).server).toBe('203.0.113.9');
    expect(Array.isArray((endpoint as any).tls.certificate)).toBe(true);
    expect((endpoint as any).tls.certificate.length).toBeGreaterThan(0);
    const json = JSON.stringify(endpoint);
    expect(json).not.toMatch(/_path/);
  });

  it('.ovpn with several remotes: targets() exposes every remote host as the pool', async () => {
    const multi = GOOD_OVPN.replace('remote vpn.example.net 1194', 'remote a.example.net 1194\nremote b.example.net 1194');
    const checked = fileProvider.check({ name: 'multi.ovpn', content: multi, username: 'me', password: 'pw' });
    expect(checked.ok).toBe(true);
    const account: Account = { id: 'file-3', providerId: 'file', label: 'Multi', meta: checked.meta!, secretRef: 'file-3' };
    const [target] = await fileProvider.targets(account);
    expect(target.servers).toEqual(['a.example.net', 'b.example.net']);

    const endpoint = fileProvider.bind(target, '203.0.113.10', account, checked.secret as AccountSecret);
    expect((endpoint as any).server).toBe('203.0.113.10');
    expect((endpoint as any).server_port).toBe(1194);
  });

  it('an account imported before meta.servers existed falls back to meta.host', async () => {
    const account: Account = {
      id: 'file-old',
      providerId: 'file',
      label: 'Old',
      meta: { format: 'openvpn', host: 'vpn.example.net', port: '1194' },
      secretRef: 'file-old',
    };
    const [target] = await fileProvider.targets(account);
    expect(target.servers).toEqual(['vpn.example.net']);
  });

  it('.conf: targets() + bind() produce a valid WireguardEndpoint with no *_path fields', async () => {
    const checked = fileProvider.check({ name: 'vpn.conf', content: GOOD_CONF });
    expect(checked.ok).toBe(true);
    const account: Account = {
      id: 'file-2',
      providerId: 'file',
      label: 'Imported WG',
      meta: checked.meta!,
      secretRef: 'file-2',
    };
    const targets = await fileProvider.targets(account);
    expect(targets).toHaveLength(1);
    expect(targets[0].servers).toEqual(['vpn.example.net']);

    const endpoint = fileProvider.bind(targets[0], '203.0.113.9', account, checked.secret as AccountSecret);
    expect(endpoint.type).toBe('wireguard');
    expect((endpoint as any).peers[0].address).toBe('203.0.113.9');
    const json = JSON.stringify(endpoint);
    expect(json).not.toMatch(/_path/);
  });
});
