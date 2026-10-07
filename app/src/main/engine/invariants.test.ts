import { describe, expect, it } from 'vitest';
import { assertConfigInvariants } from './invariants';

/** Minimal valid config shape, mutated per-test to trigger one violation at a time. */
function baseConfig(): Record<string, unknown> {
  return {
    log: { level: 'info' },
    dns: {
      servers: [{ type: 'https', server: '1.1.1.1', tag: 'dns-ep', detour: 'ep' }],
      final: 'dns-ep',
      strategy: 'ipv4_only',
    },
    endpoints: [{ type: 'wireguard', tag: 'ep', system: false, address: ['10.14.0.2/16'], private_key: 'x', peers: [] }],
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 29001 }],
    outbounds: [{ type: 'block', tag: 'block' }],
    route: { rules: [{ inbound: ['in'], outbound: 'ep' }], final: 'block' },
    experimental: { clash_api: { external_controller: '127.0.0.1:9090', secret: 'x' } },
  };
}

describe('assertConfigInvariants', () => {
  it('passes a well-formed config', () => {
    expect(() => assertConfigInvariants(baseConfig())).not.toThrow();
  });

  it('passes a well-formed config with 0.0.0.0 listen (LAN sharing)', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '0.0.0.0';
    expect(() => assertConfigInvariants(cfg)).not.toThrow();
  });

  it('throws when route.final is not "block"', () => {
    const cfg = baseConfig();
    (cfg.route as Record<string, unknown>).final = 'direct';
    expect(() => assertConfigInvariants(cfg)).toThrow(/route\.final/);
  });

  it('throws on an outbound other than block or the ep endpoint', () => {
    const cfg = baseConfig();
    (cfg.outbounds as unknown[]).push({ type: 'direct', tag: 'leak' });
    expect(() => assertConfigInvariants(cfg)).toThrow(/outbound/i);
  });

  it('throws when a dns server lacks detour', () => {
    const cfg = baseConfig();
    (cfg.dns as Record<string, unknown>).servers = [{ type: 'https', server: '1.1.1.1', tag: 'dns-ep' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/detour/);
  });

  it('throws when an endpoint has system !== false (missing)', () => {
    const cfg = baseConfig();
    delete (cfg.endpoints as Array<Record<string, unknown>>)[0].system;
    expect(() => assertConfigInvariants(cfg)).toThrow(/system/);
  });

  it('throws when an endpoint has system: true', () => {
    const cfg = baseConfig();
    (cfg.endpoints as Array<Record<string, unknown>>)[0].system = true;
    expect(() => assertConfigInvariants(cfg)).toThrow(/system/);
  });

  it('throws on a services entry of type "api"', () => {
    const cfg = baseConfig();
    cfg.services = [{ type: 'api', tag: 'v2ray-api' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/services|api/i);
  });

  it('throws on experimental.v2ray_api', () => {
    const cfg = baseConfig();
    (cfg.experimental as Record<string, unknown>).v2ray_api = { listen: '127.0.0.1:8080' };
    expect(() => assertConfigInvariants(cfg)).toThrow(/v2ray_api/);
  });

  it('throws on a listen host that is neither 127.0.0.1 nor 0.0.0.0', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '192.168.1.5';
    expect(() => assertConfigInvariants(cfg)).toThrow(/listen/);
  });

  it('throws on non-object input', () => {
    expect(() => assertConfigInvariants(null)).toThrow();
    expect(() => assertConfigInvariants('nope')).toThrow();
  });
});
