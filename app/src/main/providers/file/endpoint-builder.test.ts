import { describe, expect, it } from 'vitest';
import { buildOvpnEndpoint } from './endpoint-builder';
import type { ParsedOvpn } from './ovpn-parser';

const FAKE_CA_LINES = ['-----BEGIN CERTIFICATE-----', 'ZmFrZQ==', '-----END CERTIFICATE-----'];

function baseParsed(overrides: Partial<ParsedOvpn> = {}): ParsedOvpn {
  return {
    remoteHost: 'vpn.example.net',
    remotePort: 1194,
    proto: 'udp',
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
