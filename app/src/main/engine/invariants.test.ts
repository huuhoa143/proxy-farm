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

  it('passes a well-formed config with 0.0.0.0 listen + non-empty users (LAN sharing)', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '0.0.0.0';
    (cfg.inbounds as Array<Record<string, unknown>>)[0].users = [{ username: 'u', password: 'p' }];
    expect(() => assertConfigInvariants(cfg)).not.toThrow();
  });

  it('throws when a 0.0.0.0 inbound user is missing a password (would be an open LAN proxy)', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '0.0.0.0';
    (cfg.inbounds as Array<Record<string, unknown>>)[0].users = [{ username: 'u' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/non-empty username and password/);
  });

  it('throws when a 0.0.0.0 inbound user has an empty username', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '0.0.0.0';
    (cfg.inbounds as Array<Record<string, unknown>>)[0].users = [{ username: '', password: 'p' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/non-empty username and password/);
  });

  it('throws on non-object input', () => {
    expect(() => assertConfigInvariants(null)).toThrow();
    expect(() => assertConfigInvariants('nope')).toThrow();
  });

  // ── log ────────────────────────────────────────────────────────────────
  it('throws when log.level is not "info"', () => {
    const cfg = baseConfig();
    (cfg.log as Record<string, unknown>).level = 'debug';
    expect(() => assertConfigInvariants(cfg)).toThrow(/log\.level/);
  });

  // ── endpoints ──────────────────────────────────────────────────────────
  it('throws when there are zero endpoints', () => {
    const cfg = baseConfig();
    cfg.endpoints = [];
    expect(() => assertConfigInvariants(cfg)).toThrow(/exactly one endpoint/);
  });

  it('throws when there is more than one endpoint', () => {
    const cfg = baseConfig();
    (cfg.endpoints as unknown[]).push({ type: 'wireguard', tag: 'ep2', system: false });
    expect(() => assertConfigInvariants(cfg)).toThrow(/exactly one endpoint/);
  });

  it('throws when the endpoint is not tagged "ep"', () => {
    const cfg = baseConfig();
    (cfg.endpoints as Array<Record<string, unknown>>)[0].tag = 'wrong';
    expect(() => assertConfigInvariants(cfg)).toThrow(/tagged "ep"/);
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

  it('throws when the endpoint contains a "*_path" key anywhere (CA/keys must be inlined)', () => {
    const cfg = baseConfig();
    (cfg.endpoints as Array<Record<string, unknown>>)[0].tls = { certificate_path: '/etc/ca.pem' };
    expect(() => assertConfigInvariants(cfg)).toThrow(/certificate_path|file path/);
  });

  it('throws when a "*_path" key is nested deep inside the endpoint', () => {
    const cfg = baseConfig();
    (cfg.endpoints as Array<Record<string, unknown>>)[0].tls = { control_wrap: { key_path: '/etc/key' } };
    expect(() => assertConfigInvariants(cfg)).toThrow(/key_path|file path/);
  });

  // ── outbounds ──────────────────────────────────────────────────────────
  it('throws when outbounds has an extra entry beyond block', () => {
    const cfg = baseConfig();
    (cfg.outbounds as unknown[]).push({ type: 'direct', tag: 'leak' });
    expect(() => assertConfigInvariants(cfg)).toThrow(/outbounds must be exactly/);
  });

  it('throws when the single outbound is not type "block"', () => {
    const cfg = baseConfig();
    cfg.outbounds = [{ type: 'direct', tag: 'block' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/outbounds must be exactly/);
  });

  it('throws when the single outbound carries an extra key', () => {
    const cfg = baseConfig();
    cfg.outbounds = [{ type: 'block', tag: 'block', extra: true }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/outbounds must be exactly/);
  });

  // ── dns ────────────────────────────────────────────────────────────────
  it('throws when dns.strategy is not "ipv4_only"', () => {
    const cfg = baseConfig();
    (cfg.dns as Record<string, unknown>).strategy = 'prefer_ipv4';
    expect(() => assertConfigInvariants(cfg)).toThrow(/ipv4_only/);
  });

  it('throws when a dns server is type "local"', () => {
    const cfg = baseConfig();
    (cfg.dns as Record<string, unknown>).servers = [{ type: 'local', tag: 'dns-ep', detour: 'ep' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/"local"/);
  });

  it('throws when a dns server has detour !== "ep"', () => {
    const cfg = baseConfig();
    (cfg.dns as Record<string, unknown>).servers = [{ type: 'https', server: '1.1.1.1', tag: 'dns-ep', detour: 'direct' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/detour/);
  });

  it('throws when a dns server lacks detour entirely', () => {
    const cfg = baseConfig();
    (cfg.dns as Record<string, unknown>).servers = [{ type: 'https', server: '1.1.1.1', tag: 'dns-ep' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/detour/);
  });

  it('throws when dns.final does not reference any dns server tag', () => {
    const cfg = baseConfig();
    (cfg.dns as Record<string, unknown>).final = 'dns-ghost';
    expect(() => assertConfigInvariants(cfg)).toThrow(/dns\.final/);
  });

  // ── inbound ────────────────────────────────────────────────────────────
  it('throws when there are zero inbounds', () => {
    const cfg = baseConfig();
    cfg.inbounds = [];
    expect(() => assertConfigInvariants(cfg)).toThrow(/exactly one inbound/);
  });

  it('throws when there is more than one inbound', () => {
    const cfg = baseConfig();
    (cfg.inbounds as unknown[]).push({ type: 'mixed', tag: 'in2', listen: '127.0.0.1', listen_port: 29002 });
    expect(() => assertConfigInvariants(cfg)).toThrow(/exactly one inbound/);
  });

  it('throws when the inbound is not type "mixed"', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].type = 'socks';
    expect(() => assertConfigInvariants(cfg)).toThrow(/"mixed"/);
  });

  it('throws on a listen host that is neither 127.0.0.1 nor 0.0.0.0', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '192.168.1.5';
    expect(() => assertConfigInvariants(cfg)).toThrow(/listen host/);
  });

  it('throws when listen is 0.0.0.0 with no users at all', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '0.0.0.0';
    expect(() => assertConfigInvariants(cfg)).toThrow(/users/);
  });

  it('throws when listen is 0.0.0.0 with an empty users array', () => {
    const cfg = baseConfig();
    (cfg.inbounds as Array<Record<string, unknown>>)[0].listen = '0.0.0.0';
    (cfg.inbounds as Array<Record<string, unknown>>)[0].users = [];
    expect(() => assertConfigInvariants(cfg)).toThrow(/users/);
  });

  // ── clash_api ──────────────────────────────────────────────────────────
  it('throws when clash_api.external_controller is not on 127.0.0.1', () => {
    const cfg = baseConfig();
    (cfg.experimental as Record<string, unknown>).clash_api = { external_controller: '0.0.0.0:9090', secret: 'x' };
    expect(() => assertConfigInvariants(cfg)).toThrow(/127\.0\.0\.1/);
  });

  it('throws when clash_api.secret is empty', () => {
    const cfg = baseConfig();
    (cfg.experimental as Record<string, unknown>).clash_api = { external_controller: '127.0.0.1:9090', secret: '' };
    expect(() => assertConfigInvariants(cfg)).toThrow(/secret/);
  });

  it('throws when clash_api.secret is missing', () => {
    const cfg = baseConfig();
    (cfg.experimental as Record<string, unknown>).clash_api = { external_controller: '127.0.0.1:9090' };
    expect(() => assertConfigInvariants(cfg)).toThrow(/secret/);
  });

  // ── route ──────────────────────────────────────────────────────────────
  it('throws when route.final is not "block"', () => {
    const cfg = baseConfig();
    (cfg.route as Record<string, unknown>).final = 'direct';
    expect(() => assertConfigInvariants(cfg)).toThrow(/route\.final/);
  });

  it('throws when a route rule outbound is not "ep" or "block"', () => {
    const cfg = baseConfig();
    (cfg.route as Record<string, unknown>).rules = [{ inbound: ['in'], outbound: 'direct' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/route rule outbound/);
  });

  it('passes when a route rule outbound is "block"', () => {
    const cfg = baseConfig();
    (cfg.route as Record<string, unknown>).rules = [{ inbound: ['in'], outbound: 'block' }];
    expect(() => assertConfigInvariants(cfg)).not.toThrow();
  });

  // ── services / v2ray_api ───────────────────────────────────────────────
  it('throws on a services entry of type "api" (not a real sing-box type, but still rejected)', () => {
    const cfg = baseConfig();
    cfg.services = [{ type: 'api', tag: 'v2ray-api' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/services/i);
  });

  it('throws on a services entry of a real sing-box type ("derp")', () => {
    const cfg = baseConfig();
    cfg.services = [{ type: 'derp', tag: 'derp-in' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/services/i);
  });

  it('throws on a services entry of a real sing-box type ("ssm-api")', () => {
    const cfg = baseConfig();
    cfg.services = [{ type: 'ssm-api', tag: 'ssm' }];
    expect(() => assertConfigInvariants(cfg)).toThrow(/services/i);
  });

  it('passes when services is an empty array', () => {
    const cfg = baseConfig();
    cfg.services = [];
    expect(() => assertConfigInvariants(cfg)).not.toThrow();
  });

  it('throws on experimental.v2ray_api', () => {
    const cfg = baseConfig();
    (cfg.experimental as Record<string, unknown>).v2ray_api = { listen: '127.0.0.1:8080' };
    expect(() => assertConfigInvariants(cfg)).toThrow(/v2ray_api/);
  });
});
