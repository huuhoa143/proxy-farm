import { ENDPOINT_TAG } from '../../shared/contracts';

const PATH_KEY_RE = /_path$/i;

/**
 * Throws on any violation of the sing-box config invariants in spec §6.1.
 * Runs on every provider's rendered output (`renderConfig`), and is also
 * exercised directly against hand-built fixtures in tests. Operates on
 * `unknown` (a `JSON.parse`'d config) rather than a typed shape, since its
 * whole job is to catch a renderer that produced something unexpected.
 *
 * Deliberately strict/exhaustive rather than merely "no obvious leak": every
 * clause below is load-bearing and independently tested.
 */
export function assertConfigInvariants(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('assertConfigInvariants: config is not an object');
  }
  const cfg = parsed as Record<string, unknown>;

  assertLogLevel(cfg);
  assertExactlyOneEndpoint(cfg);
  assertOutboundsExact(cfg);
  assertDns(cfg);
  assertInbound(cfg);
  assertClashApi(cfg);
  assertRoute(cfg);
  assertNoApiService(cfg);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively scans for any object key ending in `_path` (CA/keys must be inlined, never path-referenced). */
function findPathKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPathKey(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (PATH_KEY_RE.test(key)) return key;
      const found = findPathKey(v);
      if (found) return found;
    }
  }
  return null;
}

function assertLogLevel(cfg: Record<string, unknown>): void {
  const log = cfg.log as Record<string, unknown> | undefined;
  if (log?.level !== 'info') {
    throw new Error(`assertConfigInvariants: log.level must be "info", got ${JSON.stringify(log?.level)}`);
  }
}

function assertExactlyOneEndpoint(cfg: Record<string, unknown>): void {
  const endpoints = asArray(cfg.endpoints);
  if (endpoints.length !== 1) {
    throw new Error(`assertConfigInvariants: expected exactly one endpoint, got ${endpoints.length}`);
  }
  const endpoint = endpoints[0] as Record<string, unknown>;
  if (endpoint.tag !== ENDPOINT_TAG) {
    throw new Error(`assertConfigInvariants: the endpoint must be tagged "${ENDPOINT_TAG}", got ${JSON.stringify(endpoint.tag)}`);
  }
  if (endpoint.system !== false) {
    throw new Error(`assertConfigInvariants: endpoint must have system:false, got ${JSON.stringify(endpoint.system)}`);
  }
  const pathKey = findPathKey(endpoint);
  if (pathKey) {
    throw new Error(`assertConfigInvariants: endpoint must not reference a file path — found "${pathKey}" (CA/keys must be inlined)`);
  }
}

function assertOutboundsExact(cfg: Record<string, unknown>): void {
  const outbounds = asArray(cfg.outbounds);
  const isExactBlock =
    outbounds.length === 1 &&
    isRecord(outbounds[0]) &&
    Object.keys(outbounds[0]).length === 2 &&
    outbounds[0].type === 'block' &&
    outbounds[0].tag === 'block';
  if (!isExactBlock) {
    throw new Error(`assertConfigInvariants: outbounds must be exactly [{type:"block",tag:"block"}], got ${JSON.stringify(outbounds)}`);
  }
}

function assertDns(cfg: Record<string, unknown>): void {
  const dns = (cfg.dns ?? {}) as Record<string, unknown>;
  if (dns.strategy !== 'ipv4_only') {
    throw new Error(`assertConfigInvariants: dns.strategy must be "ipv4_only", got ${JSON.stringify(dns.strategy)}`);
  }

  const servers = asArray(dns.servers);
  const tags = new Set<unknown>();
  for (const server of servers) {
    const s = server as Record<string, unknown>;
    if (s?.type === 'local') {
      throw new Error('assertConfigInvariants: a dns server of type "local" is not allowed (would leak host DNS)');
    }
    if (s?.detour !== ENDPOINT_TAG) {
      throw new Error(`assertConfigInvariants: dns server ${JSON.stringify(server)} must have detour === "${ENDPOINT_TAG}"`);
    }
    tags.add(s?.tag);
  }

  if (!tags.has(dns.final)) {
    throw new Error(`assertConfigInvariants: dns.final (${JSON.stringify(dns.final)}) must reference one of the dns servers' tags`);
  }
}

function assertInbound(cfg: Record<string, unknown>): void {
  const inbounds = asArray(cfg.inbounds);
  if (inbounds.length !== 1) {
    throw new Error(`assertConfigInvariants: expected exactly one inbound, got ${inbounds.length}`);
  }
  const inbound = inbounds[0] as Record<string, unknown>;
  if (inbound.type !== 'mixed') {
    throw new Error(`assertConfigInvariants: the inbound must be type "mixed", got ${JSON.stringify(inbound.type)}`);
  }
  if (inbound.listen !== '127.0.0.1' && inbound.listen !== '0.0.0.0') {
    throw new Error(`assertConfigInvariants: inbound listen host must be "127.0.0.1" or "0.0.0.0", got ${JSON.stringify(inbound.listen)}`);
  }
  if (inbound.listen === '0.0.0.0') {
    const users = inbound.users;
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error('assertConfigInvariants: inbound.users must be non-empty when listen is "0.0.0.0" (LAN sharing requires proxy auth)');
    }
  }
}

function assertClashApi(cfg: Record<string, unknown>): void {
  const experimental = cfg.experimental as Record<string, unknown> | undefined;
  const clashApi = experimental?.clash_api as Record<string, unknown> | undefined;
  const externalController = clashApi?.external_controller;
  const host = typeof externalController === 'string' ? externalController.split(':')[0] : undefined;
  if (host !== '127.0.0.1') {
    throw new Error(`assertConfigInvariants: experimental.clash_api.external_controller must be on 127.0.0.1, got ${JSON.stringify(externalController)}`);
  }
  if (typeof clashApi?.secret !== 'string' || clashApi.secret.length === 0) {
    throw new Error('assertConfigInvariants: experimental.clash_api.secret must be a non-empty string');
  }
}

function assertRoute(cfg: Record<string, unknown>): void {
  const route = (cfg.route ?? {}) as Record<string, unknown>;
  if (route.final !== 'block') {
    throw new Error(`assertConfigInvariants: route.final must be "block", got ${JSON.stringify(route.final)}`);
  }
  for (const rule of asArray(route.rules)) {
    const r = rule as Record<string, unknown>;
    if (r?.outbound !== ENDPOINT_TAG && r?.outbound !== 'block') {
      throw new Error(`assertConfigInvariants: route rule outbound must be "${ENDPOINT_TAG}" or "block", got ${JSON.stringify(r?.outbound)}`);
    }
  }
}

function assertNoApiService(cfg: Record<string, unknown>): void {
  // No `services` entry is allowed at all — not just type "api" (which isn't even a real sing-box
  // service type). Real services like 'derp' or 'ssm-api' are additional listeners/attack surface
  // this app has no reason to run, so the whole `services` array must be empty or absent.
  const services = asArray(cfg.services);
  if (services.length > 0) {
    throw new Error(`assertConfigInvariants: "services" must be empty or absent, got ${JSON.stringify(services)}`);
  }
  const experimental = cfg.experimental as Record<string, unknown> | undefined;
  if (experimental && 'v2ray_api' in experimental) {
    throw new Error('assertConfigInvariants: experimental.v2ray_api is not allowed');
  }
}
