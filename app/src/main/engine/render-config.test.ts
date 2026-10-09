import { describe, expect, it } from 'vitest';
import { renderConfig } from './render-config';
import { assertConfigInvariants } from './invariants';
import { sampleOpenVpnEndpoint, sampleWireguardEndpoint } from './__fixtures__/endpoints';
import { ENDPOINT_TAG, type RenderInput } from '../../shared/contracts';

function baseInput(endpoint: RenderInput['endpoint']): RenderInput {
  return {
    endpoint,
    listen: { host: '127.0.0.1', port: 29001 },
    clash: { port: 9090, secret: 'test-clash-secret' },
  };
}

describe('renderConfig', () => {
  it('returns valid JSON that passes assertConfigInvariants for an OpenVPN endpoint', () => {
    const json = renderConfig(baseInput(sampleOpenVpnEndpoint));
    const parsed = JSON.parse(json);
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it('inlines a client certificate and key, and passes the new OpenVPN options through as given', () => {
    const cert = ['-----BEGIN CERTIFICATE-----', 'Y2VydA==', '-----END CERTIFICATE-----'];
    const key = ['-----BEGIN PRIVATE KEY-----', 'a2V5', '-----END PRIVATE KEY-----'];
    const endpoint = {
      ...sampleOpenVpnEndpoint,
      tls: { ...sampleOpenVpnEndpoint.tls, server_name_type: 'name-prefix' as const, client_certificate: cert, client_key: key, ns_certificate_type: 'server' as const },
      fragment: 1300,
      mss_fix: 1200,
      compression_lzo: 'no' as const,
    };
    const parsed = JSON.parse(renderConfig(baseInput(endpoint)));
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
    expect(parsed.endpoints[0]).toMatchObject({ fragment: 1300, mss_fix: 1200, compression_lzo: 'no' });
    expect(parsed.endpoints[0].tls).toMatchObject({ client_certificate: cert, client_key: key, server_name_type: 'name-prefix', ns_certificate_type: 'server' });
  });

  it('returns valid JSON that passes assertConfigInvariants for a WireGuard endpoint', () => {
    const json = renderConfig(baseInput(sampleWireguardEndpoint));
    const parsed = JSON.parse(json);
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it('sets dns to a single DoH server detoured through the endpoint, final dns-ep, strategy ipv4_only', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    expect(parsed.dns).toEqual({
      servers: [{ type: 'https', server: '1.1.1.1', tag: 'dns-ep', detour: ENDPOINT_TAG }],
      final: 'dns-ep',
      strategy: 'ipv4_only',
    });
  });

  it('has exactly one mixed inbound on the given listen host/port', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    expect(parsed.inbounds).toHaveLength(1);
    expect(parsed.inbounds[0]).toMatchObject({ type: 'mixed', listen: '127.0.0.1', listen_port: 29001 });
  });

  it('includes proxy auth users on the mixed inbound when given', () => {
    const input = baseInput(sampleWireguardEndpoint);
    input.listen = { host: '0.0.0.0', port: 29002, proxyAuth: { username: 'u1', password: 'p1' } };
    const parsed = JSON.parse(renderConfig(input));
    expect(parsed.inbounds[0].users).toEqual([{ username: 'u1', password: 'p1' }]);
  });

  it('sets route.final to block and routes the inbound to the endpoint tag', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    expect(parsed.route.final).toBe('block');
    expect(parsed.route.rules).toEqual([{ inbound: [parsed.inbounds[0].tag], outbound: ENDPOINT_TAG }]);
  });

  it('has outbounds containing only the block outbound', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    expect(parsed.outbounds).toEqual([{ type: 'block', tag: 'block' }]);
  });

  it('sets experimental.clash_api with the given port and secret, no v2ray_api, no services', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    expect(parsed.experimental.clash_api).toEqual({ external_controller: '127.0.0.1:9090', secret: 'test-clash-secret' });
    expect(parsed.experimental.v2ray_api).toBeUndefined();
    expect(parsed.services).toBeUndefined();
  });

  it('sets log.level to info with timestamps on', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    expect(parsed.log.level).toBe('info');
    expect(parsed.log.timestamp).toBe(true);
  });

  it('inlines the endpoint with tag ep and system:false, embedding CA/keys inline (no paths)', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleOpenVpnEndpoint)));
    expect(parsed.endpoints).toHaveLength(1);
    const ep = parsed.endpoints[0];
    expect(ep.tag).toBe(ENDPOINT_TAG);
    expect(ep.system).toBe(false);
    expect(ep.tls.certificate).toEqual(sampleOpenVpnEndpoint.tls.certificate);
    expect(ep.tls).not.toHaveProperty('certificate_path');
    expect(ep.username).toBe('dummy-user');
    expect(ep.password).toBe('dummy-pass');
  });

  it('inlines the wireguard private key and peer public key (no paths)', () => {
    const parsed = JSON.parse(renderConfig(baseInput(sampleWireguardEndpoint)));
    const ep = parsed.endpoints[0];
    expect(ep.private_key).toBe(sampleWireguardEndpoint.private_key);
    expect(ep.peers[0].public_key).toBe(sampleWireguardEndpoint.peers[0].public_key);
    expect(ep.system).toBe(false);
  });

  it('throws when listen.host is 0.0.0.0 without proxyAuth (LAN sharing requires proxy auth)', () => {
    const input = baseInput(sampleWireguardEndpoint);
    input.listen = { host: '0.0.0.0', port: 29002 };
    expect(() => renderConfig(input)).toThrow(/proxyAuth/);
  });

  it('does not throw when listen.host is 0.0.0.0 with proxyAuth', () => {
    const input = baseInput(sampleWireguardEndpoint);
    input.listen = { host: '0.0.0.0', port: 29002, proxyAuth: { username: 'u', password: 'p' } };
    expect(() => renderConfig(input)).not.toThrow();
  });
});
