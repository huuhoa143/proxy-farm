/**
 * Pure helpers behind the maintainer's ZoogVPN host enumeration
 * (`scripts/zoog-scan-servers.ts`, spec §5.2). The script does the DNS; the
 * naming rules, city attribution, de-duplication and file layout live here so
 * they are unit-tested and shared with the provider.
 *
 * ZoogVPN numbers its hosts per country: `<cc><n>.webunlim.com`, some on
 * `.zoogvpn.com`, US ones with a region label (`us1.east.webunlim.com`). The
 * prefix is not always the ISO code (`uk` for GB), so patterns are learned
 * from the bundled list rather than derived from country codes.
 *
 * City rule: a region label in the host (`us1.east…`) is the city, title-cased
 * ("East"); otherwise the host gets the city the bundled list already uses for
 * region-less hosts of that country (the country name today — ZoogVPN names
 * no cities). Hosts of one country with no region therefore form one location.
 */
import type { ZoogServer } from './servers';

export const ZOOG_DOMAINS = ['webunlim.com', 'zoogvpn.com'] as const;

const HOST_RE = /^([a-z]+)(\d+)\.(?:([a-z]+)\.)?(webunlim\.com|zoogvpn\.com)$/;

export interface ZoogHostParts {
  prefix: string;
  n: number;
  region?: string;
  domain: string;
}

/** Splits a numbered host; undefined for hosts outside the scheme (e.g. `uk.zgfree.info`). */
export function parseZoogHost(host: string): ZoogHostParts | undefined {
  const m = HOST_RE.exec(host.toLowerCase());
  if (!m) return undefined;
  return { prefix: m[1], n: Number(m[2]), region: m[3], domain: m[4] };
}

export function zoogHostName(parts: ZoogHostParts): string {
  return `${parts.prefix}${parts.n}.${parts.region ? `${parts.region}.` : ''}${parts.domain}`;
}

/** One numbered series to enumerate: `<prefix><n>.[<region>.]<domain>` for every known domain. */
export interface ZoogSeries {
  country: string;
  countryName: string;
  prefix: string;
  region?: string;
  /** Highest n the bundled list already holds; enumeration runs at least this far. */
  knownMax: number;
}

/** The series to enumerate, learned from the hosts already in the bundled list. */
export function seriesOf(servers: ZoogServer[]): ZoogSeries[] {
  const byId = new Map<string, ZoogSeries>();
  for (const s of servers) {
    const parts = parseZoogHost(s.host);
    if (!parts) continue;
    const id = `${s.country}|${parts.prefix}|${parts.region ?? ''}`;
    const known = byId.get(id);
    if (known) known.knownMax = Math.max(known.knownMax, parts.n);
    else byId.set(id, { country: s.country, countryName: s.countryName, prefix: parts.prefix, region: parts.region, knownMax: parts.n });
  }
  return [...byId.values()];
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** City of a host per the rule in the header comment. */
export function cityOf(host: string, country: string, countryName: string, bundled: ZoogServer[]): string {
  const region = parseZoogHost(host)?.region;
  if (region) return titleCase(region);
  const sameCountry = bundled.find((s) => s.country === country && !parseZoogHost(s.host)?.region);
  return sameCountry?.city ?? countryName;
}

export interface ResolvedHost {
  host: string;
  country: string;
  countryName: string;
  /** IPv4 addresses the host resolved to; empty = no A record. */
  ips: string[];
}

export interface ScanResult {
  servers: ZoogServer[];
  /** Bundled hosts that no longer resolve (dropped). */
  vanished: string[];
  /** Newly found hosts skipped because another host of the same location has the same IP. */
  duplicates: Array<{ host: string; sameAs: string }>;
  /** Hosts of different locations sharing an IP (all kept; the controller compares resolved IPs). */
  crossLocation: Array<{ ip: string; hosts: string[] }>;
}

const DISCOVERED_PROTOS: ZoogServer['protos'] = { udp: 1194 };

/**
 * Merges the bundled list with the hosts found by enumeration.
 *
 * - A bundled host is kept while it resolves (existing ports may be pinned to
 *   it by name), even if it shares an IP with another bundled host.
 * - A new host is added unless a host already in its location resolves to the
 *   same IP (one server = one exit IP).
 * - The bundled `protos` are kept; new hosts get UDP 1194 only, the one
 *   transport the provider uses and the one verified on unlisted hosts.
 */
export function mergeScan(bundled: ZoogServer[], bundledIps: Map<string, string[]>, found: ResolvedHost[]): ScanResult {
  const servers: ZoogServer[] = [];
  const vanished: string[] = [];
  const duplicates: ScanResult['duplicates'] = [];
  const ipsByLocation = new Map<string, Map<string, string>>(); // location → ip → host
  const locationOf = (s: { country: string; city: string }) => `${s.country}|${s.city}`;
  const claim = (s: ZoogServer, ips: string[]) => {
    const loc = locationOf(s);
    let m = ipsByLocation.get(loc);
    if (!m) ipsByLocation.set(loc, (m = new Map()));
    for (const ip of ips) if (!m.has(ip)) m.set(ip, s.host);
  };

  const bundledHosts = new Set(bundled.map((s) => s.host));
  for (const s of bundled) {
    const ips = bundledIps.get(s.host) ?? [];
    if (ips.length === 0) {
      vanished.push(s.host);
      continue;
    }
    // Field by field: drops fields older lists carried (the per-host `key`).
    const kept: ZoogServer = { host: s.host, country: s.country, countryName: s.countryName, city: s.city, protos: s.protos };
    servers.push(kept);
    claim(kept, ips);
  }

  for (const f of found) {
    if (bundledHosts.has(f.host) || f.ips.length === 0) continue;
    const s: ZoogServer = {
      host: f.host,
      country: f.country,
      countryName: f.countryName,
      city: cityOf(f.host, f.country, f.countryName, bundled),
      protos: { ...DISCOVERED_PROTOS },
    };
    const taken = ipsByLocation.get(locationOf(s));
    const clash = f.ips.map((ip) => taken?.get(ip)).find(Boolean);
    if (clash) {
      duplicates.push({ host: f.host, sameAs: clash });
      continue;
    }
    servers.push(s);
    claim(s, f.ips);
  }

  const hostsByIp = new Map<string, Set<string>>();
  const locByHost = new Map(servers.map((s) => [s.host, locationOf(s)]));
  for (const s of servers) {
    for (const ip of bundledIps.get(s.host) ?? found.find((f) => f.host === s.host)?.ips ?? []) {
      if (!hostsByIp.has(ip)) hostsByIp.set(ip, new Set());
      hostsByIp.get(ip)!.add(s.host);
    }
  }
  const crossLocation = [...hostsByIp]
    .filter(([, hosts]) => new Set([...hosts].map((h) => locByHost.get(h))).size > 1)
    .map(([ip, hosts]) => ({ ip, hosts: [...hosts].sort() }));

  return { servers: sortServers(servers), vanished, duplicates, crossLocation };
}

/** Country, city, then numbered hosts by number (webunlim before zoogvpn), then off-scheme hosts. */
export function sortServers(servers: ZoogServer[]): ZoogServer[] {
  const rank = (s: ZoogServer): [number, number, string] => {
    const p = parseZoogHost(s.host);
    return p ? [0, p.n, p.domain === 'webunlim.com' ? '0' : '1'] : [1, 0, s.host];
  };
  return [...servers].sort((a, b) => {
    if (a.country !== b.country) return a.country < b.country ? -1 : 1;
    if (a.city !== b.city) return a.city < b.city ? -1 : 1;
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  });
}

/** The bundled file, one server per line so enumeration diffs stay reviewable. */
export function formatServersFile(servers: ZoogServer[], scanned: string): string {
  const lines = servers.map((s) => `    ${JSON.stringify(s)}`);
  return `{\n  "scanned": ${JSON.stringify(scanned)},\n  "servers": [\n${lines.join(',\n')}\n  ]\n}\n`;
}
