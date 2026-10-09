/**
 * NordVPN server list (spec §5.5): the public, unauthenticated
 * `https://api.nordvpn.com/v1/servers`, filtered to NordLynx (`wireguard_udp`)
 * servers, grouped into one location per (country, city) and cached on disk
 * for 12 h next to Surfshark's cluster cache.
 *
 * One request fetches the whole list. Unfiltered it is ~27 MB (≈ 3.9 kB per
 * server); the `fields[...]` projection below keeps only what the app uses,
 * and the response is gzip-compressed on the wire. Measured 2026-10-09:
 * 6950 servers, 150 countries, 225 cities, 1 request, ~200 kB transferred
 * (5.3 MB decompressed), under a second. Paging would only add requests.
 *
 * Every server carries its own WireGuard public key (shared per cluster, e.g.
 * all Hanoi servers have one). The cache keeps it per server so `bind()` can
 * read it synchronously and deterministically, without a prior `targets()`.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SERVERS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const FIELDS = [
  'servers.hostname',
  'servers.station',
  'servers.load',
  'servers.locations.country.code',
  'servers.locations.country.name',
  'servers.locations.country.city.name',
  'servers.technologies.identifier',
  'servers.technologies.metadata',
  // `{identifier:'virtual_location', values:[{value:'true'}]}` marks a virtual location ✅
  // 2026-10-09 (vn52, vn53, vn56: Vietnam servers whose IPs geolocate elsewhere).
  'servers.specifications.identifier',
  'servers.specifications.values',
];

/** The full NordLynx server list, trimmed to the fields above. `limit` is far above the
 * real count (≈ 7000) so one request returns everything. */
export const SERVERS_URL =
  'https://api.nordvpn.com/v1/servers?limit=16384&filters[servers_technologies][identifier]=wireguard_udp&' +
  FIELDS.map((f) => `fields[${f}]`).join('&');

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const FETCH_TIMEOUT_MS = 30_000;

export interface NordServer {
  /** The server's IPv4 (`station`): what the port pins and the WireGuard peer address. */
  ip: string;
  hostname: string;
  /** Nord's load percentage at fetch time. */
  load: number;
  /** The server's WireGuard public key. */
  publicKey: string;
  /** Nord marks the server a virtual location: it stands in another country and only
   * presents as this one. Absent when not marked (or cached before the flag was read). */
  virtual?: true;
}

export interface NordLocation {
  key: string; // nordvpn:<CC>-<CITY-SLUG>
  country: string; // ISO-3166 alpha-2, upper case
  countryName: string;
  city: string;
  /** Least loaded first. */
  servers: NordServer[];
  /** Every server of the location is a virtual location. */
  virtual?: true;
}

/** The server's `virtual_location` specification says `true`. */
function isVirtualServer(rec: Record<string, unknown>): boolean {
  if (!Array.isArray(rec.specifications)) return false;
  const spec = (rec.specifications as Array<Record<string, unknown>>).find((s) => s?.identifier === 'virtual_location');
  const values = Array.isArray(spec?.values) ? (spec.values as Array<Record<string, unknown>>) : [];
  return values.some((v) => v?.value === true || v?.value === 'true');
}

export interface ServersCacheFile {
  version: 1;
  fetchedAt: number;
  locations: NordLocation[];
}

/** `HO CHI MINH CITY` → `HO-CHI-MINH-CITY`; accents folded (`São Paulo` → `SAO-PAULO`). */
export function citySlug(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Stable location key, derived from data only: `nordvpn:VN-HO-CHI-MINH-CITY`. */
export function nordLocationKey(country: string, city: string): string {
  return `nordvpn:${country.toUpperCase()}-${citySlug(city)}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * The API payload → locations. Servers without an IPv4 station, a location, or a
 * well-formed `wireguard_udp` public key are skipped. Within a location servers are
 * ordered by load, then by IP so the order is deterministic; locations by key.
 */
export function parseServers(payload: unknown): NordLocation[] {
  if (!Array.isArray(payload)) throw new Error('nordvpn: servers payload is not an array');
  const byKey = new Map<string, NordLocation>();
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const ip = str(rec.station);
    if (!IPV4_RE.test(ip)) continue;
    const loc = Array.isArray(rec.locations) ? (rec.locations[0] as Record<string, unknown> | undefined) : undefined;
    const country = (loc?.country ?? {}) as Record<string, unknown>;
    const code = str(country.code).toUpperCase();
    const city = str((country.city as Record<string, unknown> | undefined)?.name).trim();
    if (!/^[A-Z]{2}$/.test(code) || !city || !citySlug(city)) continue;
    const wg = Array.isArray(rec.technologies)
      ? (rec.technologies as Array<Record<string, unknown>>).find((t) => t?.identifier === 'wireguard_udp')
      : undefined;
    const meta = Array.isArray(wg?.metadata) ? (wg.metadata as Array<Record<string, unknown>>) : [];
    const publicKey = str(meta.find((m) => m?.name === 'public_key')?.value);
    if (!WG_KEY_RE.test(publicKey)) continue;

    const key = nordLocationKey(code, city);
    let location = byKey.get(key);
    if (!location) {
      location = { key, country: code, countryName: str(country.name) || code, city, servers: [] };
      byKey.set(key, location);
    }
    if (location.servers.some((s) => s.ip === ip)) continue;
    const load = typeof rec.load === 'number' && Number.isFinite(rec.load) ? rec.load : 100;
    location.servers.push({ ip, hostname: str(rec.hostname), load, publicKey, ...(isVirtualServer(rec) ? { virtual: true as const } : {}) });
  }
  const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  for (const l of byKey.values()) {
    l.servers.sort((a, b) => a.load - b.load || ipNum(a.ip) - ipNum(b.ip));
    if (l.servers.every((s) => s.virtual)) l.virtual = true;
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The slice of `fetch` this module and the credential exchange use (tests inject it). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GetServersOptions {
  cachePath: string;
  now?: () => number;
  fetchImpl?: FetchLike;
}

async function readCache(cachePath: string): Promise<ServersCacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as ServersCacheFile;
    return parsed?.version === 1 && Array.isArray(parsed.locations) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, cache: ServersCacheFile): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), 'utf8');
  await rename(tmp, cachePath);
}

/**
 * Synchronous, no-network read of the cached locations, whatever their age — used by
 * `bind()`, which must be deterministic (the Surfshark cluster cache precedent).
 * `undefined` when there is no readable cache.
 */
export function readServersCacheSync(cachePath: string): NordLocation[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as ServersCacheFile;
    return parsed?.version === 1 && Array.isArray(parsed.locations) ? parsed.locations : undefined;
  } catch {
    return undefined;
  }
}

/** Fresh (within 12 h) locations, fetching and caching as needed; a stale cache beats
 * none when the fetch fails. */
export async function getServers(opts: GetServersOptions): Promise<NordLocation[]> {
  const nowMs = (opts.now ?? Date.now)();
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const cached = await readCache(opts.cachePath);
  if (cached && nowMs - cached.fetchedAt < SERVERS_CACHE_TTL_MS) return cached.locations;
  try {
    const res = await fetchImpl(SERVERS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`nordvpn: server list fetch failed with HTTP ${res.status}`);
    const locations = parseServers(await res.json());
    if (locations.length === 0) throw new Error('nordvpn: server list is empty');
    await writeCache(opts.cachePath, { version: 1, fetchedAt: nowMs, locations });
    return locations;
  } catch (err) {
    if (cached) return cached.locations;
    throw err;
  }
}
