import { describe, expect, it } from 'vitest';
import { buildOvpnEndpoint } from './endpoint-builder';
import type { ParsedOvpn } from './ovpn-parser';

const FAKE_CA_LINES = ['-----BEGIN CERTIFICATE-----', 'ZmFrZQ==', '-----END CERTIFICATE-----'];

function baseParsed(overrides: Partial<ParsedOvpn> = {}): ParsedOvpn {
  return {
    remoteHost: 'vpn.example.net',
    remotePort: 1194,
    proto: 'udp',
    remotes: [{ host: 'vpn.example.net', port: 1194, proto: 'udp' }],
    servers: ['vpn.example.net'],
    caLines: FAKE_CA_LINES,
    needsAuthUserPass: false,
    ...overrides,
  };
}

describe('buildOvpnEndpoint: mtu resolution from tun-mtu', () => {
  it('defaults to 1400 when tun-mtu is absent', () => {
    const endpoint = buildOvpnEndpoint(baseParsed({ tunMtu: undefined }), '203.0.113.1');
    expect(endpoint.mtu).toBe(1400);
  });

  it('honours a valid tun-mtu within [1280, 1500]', () => {
    const endpoint = buildOvpnEndpoint(baseParsed({ tunMtu: 1350 }), '203.0.113.1');
    expect(endpoint.mtu).toBe(1350);
  });

  it('clamps a tun-mtu below 1280 up to 1280', () => {
    const endpoint = buildOvpnEndpoint(baseParsed({ tunMtu: 1000 }), '203.0.113.1');
    expect(endpoint.mtu).toBe(1280);
  });

  it('clamps a tun-mtu above 1500 down to 1500', () => {
    const endpoint = buildOvpnEndpoint(baseParsed({ tunMtu: 9000 }), '203.0.113.1');
    expect(endpoint.mtu).toBe(1500);
  });

  it('honours the boundary values exactly', () => {
    expect(buildOvpnEndpoint(baseParsed({ tunMtu: 1280 }), '203.0.113.1').mtu).toBe(1280);
    expect(buildOvpnEndpoint(baseParsed({ tunMtu: 1500 }), '203.0.113.1').mtu).toBe(1500);
  });
});

describe('buildOvpnEndpoint: client certificate and ExpressVPN-style options', () => {
  const CERT = ['-----BEGIN CERTIFICATE-----', 'Y2VydA==', '-----END CERTIFICATE-----'];
  const KEY = ['-----BEGIN PRIVATE KEY-----', 'a2V5', '-----END PRIVATE KEY-----'];

  it('emits none of the new fields for a profile without them (unchanged output)', () => {
    const ep = buildOvpnEndpoint(baseParsed(), '203.0.113.1');
    expect(ep).toEqual({
      type: 'openvpn-client',
      server: '203.0.113.1',
      server_port: 1194,
      network: 'udp',
      username: undefined,
      password: undefined,
      tls: { certificate: FAKE_CA_LINES, remote_certificate_tls: 'server' },
      data_ciphers: ['AES-256-GCM'],
      auth: undefined,
      route_no_pull: true,
      mtu: 1400,
    });
  });

  it('maps each parsed option to its sing-box field', () => {
    const ep = buildOvpnEndpoint(
      baseParsed({
        clientCertLines: CERT,
        clientKeyLines: KEY,
        serverName: 'Server',
        serverNameType: 'name-prefix',
        nsCertType: 'server',
        fragment: 1300,
        mssFix: 1200,
        compressionLzo: 'no',
        auth: 'SHA512',
      }),
      '203.0.113.1',
      { username: 'u', password: 'p' },
    );
    expect(ep.tls).toMatchObject({
      client_certificate: CERT,
      client_key: KEY,
      server_name: 'Server',
      server_name_type: 'name-prefix',
      ns_certificate_type: 'server',
    });
    expect(ep).toMatchObject({ fragment: 1300, mss_fix: 1200, compression_lzo: 'no', auth: 'SHA512', username: 'u', password: 'p' });
  });

  it('maps the mssfix mode, and mssfix 0 to mss_fix_disabled', () => {
    expect(buildOvpnEndpoint(baseParsed({ mssFix: 1450, mssFixMode: 'mtu' }), '203.0.113.1')).toMatchObject({
      mss_fix: 1450,
      mss_fix_mode: 'mtu',
    });
    const disabled = buildOvpnEndpoint(baseParsed({ mssFixDisabled: true }), '203.0.113.1');
    expect(disabled.mss_fix_disabled).toBe(true);
    expect(disabled).not.toHaveProperty('mss_fix');
    expect(disabled).not.toHaveProperty('mss_fix_mode');
  });
});
