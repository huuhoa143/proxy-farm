import { ENDPOINT_TAG } from '../../shared/contracts';

/**
 * Throws on any violation of the sing-box config invariants in spec §6.1.
 * Runs on every provider's rendered output (`renderConfig`), and is also
 * exercised directly against hand-built fixtures in tests. Operates on
 * `unknown` (a `JSON.parse`'d config) rather than a typed shape, since its
 * whole job is to catch a renderer that produced something unexpected.
 */
export function assertConfigInvariants(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('assertConfigInvariants: config is not an object');
  }
  const cfg = parsed as Record<string, unknown>;

  assertRouteFinalIsBlock(cfg);
  assertNoStrayOutbounds(cfg);
  assertDnsServersHaveDetour(cfg);
  assertEndpointsAreUserspace(cfg);
  assertNoApiService(cfg);
  assertListenHostsAreLocalOrWildcard(cfg);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function assertRouteFinalIsBlock(cfg: Record<string, unknown>): void {
  const route = cfg.route as Record<string, unknown> | undefined;
  const final = route?.final;
  if (final !== 'block') {
    throw new Error(`assertConfigInvariants: route.final must be "block", got ${JSON.stringify(final)}`);
  }
}

function assertNoStrayOutbounds(cfg: Record<string, unknown>): void {
  for (const outbound of asArray(cfg.outbounds)) {
    const o = outbound as Record<string, unknown>;
    const tag = o?.tag;
    const isBlock = o?.type === 'block' && tag === 'block';
    const isEndpoint = tag === ENDPOINT_TAG;
    if (!isBlock && !isEndpoint) {
      throw new Error(`assertConfigInvariants: unexpected outbound ${JSON.stringify(outbound)} — only "block" or the "${ENDPOINT_TAG}" endpoint are allowed`);
    }
  }
}

function assertDnsServersHaveDetour(cfg: Record<string, unknown>): void {
  const dns = cfg.dns as Record<string, unknown> | undefined;
  for (const server of asArray(dns?.servers)) {
    const s = server as Record<string, unknown>;
    if (!s?.detour) {
      throw new Error(`assertConfigInvariants: dns server ${JSON.stringify(server)} is missing "detour"`);
    }
  }
}

function assertEndpointsAreUserspace(cfg: Record<string, unknown>): void {
  for (const endpoint of asArray(cfg.endpoints)) {
    const e = endpoint as Record<string, unknown>;
    if (e?.system !== false) {
      throw new Error(`assertConfigInvariants: endpoint ${JSON.stringify({ type: e?.type, tag: e?.tag })} must have system:false, got ${JSON.stringify(e?.system)}`);
    }
  }
}

function assertNoApiService(cfg: Record<string, unknown>): void {
  for (const service of asArray(cfg.services)) {
    const s = service as Record<string, unknown>;
    if (s?.type === 'api') {
      throw new Error(`assertConfigInvariants: a "services" entry of type "api" is not allowed: ${JSON.stringify(service)}`);
    }
  }
  const experimental = cfg.experimental as Record<string, unknown> | undefined;
  if (experimental && 'v2ray_api' in experimental) {
    throw new Error('assertConfigInvariants: experimental.v2ray_api is not allowed');
  }
}

function assertListenHostsAreLocalOrWildcard(cfg: Record<string, unknown>): void {
  for (const inbound of asArray(cfg.inbounds)) {
    const i = inbound as Record<string, unknown>;
    if (i?.listen !== '127.0.0.1' && i?.listen !== '0.0.0.0') {
      throw new Error(`assertConfigInvariants: inbound listen host must be "127.0.0.1" or "0.0.0.0", got ${JSON.stringify(i?.listen)}`);
    }
  }
}
