/**
 * NordVPN server list (spec §5.5): the public, unauthenticated
 * `https://api.nordvpn.com/v1/servers`, filtered to online NordLynx (`wireguard_udp`)
 * servers of the "Standard VPN servers" group, grouped into one location per
 * (country, city) and cached on disk for 12 h next to Surfshark's cluster cache.
 *
 * The group filter is what the Windows app asks for too (8.14.3, `ServerQueryBuilder`:
 * `filters[servers_groups][id]`, default 11) ✅ 2026-10-24. Without it the list also
 * holds Dedicated IP (group 9, ~1500), Double VPN (1) and Onion (3) servers, which an
 * ordinary account cannot use: a port pinned to one never comes up.
 *
 * Within a location the order is Nord's own: `recommendServers()` asks
 * `v1/servers/recommendations` for the location, as the app does on every connect,
 * and `applyRecommendations()` puts its answer first. Until then, least loaded first.
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
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../store/atomic-write';

export const SERVERS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** "Standard VPN servers": the group every ordinary connection uses ✅ 2026-10-24. */
export const STANDARD_GROUP_ID = 11;
/** `wireguard_udp`'s technology id, which the recommendations filter takes. */
const WIREGUARD_TECH_ID = 35;

const FIELDS = [
  'servers.hostname',
  'servers.station',
  'servers.load',
  'servers.status',
  'servers.groups.id',
  'servers.locations.country.id',
  'servers.locations.country.city.id',
  'servers.locations.country.code',
  'servers.locations.country.name',
  'servers.locations.country.city.name',
  'servers.technologies.identifier',
  'servers.technologies.metadata',
  'servers.technologies.pivot.status',
  // `{identifier:'virtual_location', values:[{value:'true'}]}` marks a virtual location ✅
  // 2026-10-09 (vn52, vn53, vn56: Vietnam servers whose IPs geolocate elsewhere).
  'servers.specifications.identifier',
  'servers.specifications.values',
];

const FIELDS_QUERY = FIELDS.map((f) => `fields[${f}]`).join('&');

/** The full NordLynx server list of the standard group, trimmed to the fields above.
 * `limit` is far above the real count (≈ 5300) so one request returns everything. */
export const SERVERS_URL =
  'https://api.nordvpn.com/v1/servers?limit=16384&filters[servers_technologies][identifier]=wireguard_udp&' +
  `filters[servers_groups][id]=${STANDARD_GROUP_ID}&${FIELDS_QUERY}`;

/** How many servers one recommendation asks for: more than a location's ports ever need,
 * a fraction of a big city (London: ≈ 500). */
export const RECOMMENDATIONS_LIMIT = 30;

/** Nord's recommended servers for one location, best first, with the filters the app sends
 * (8.14.3 `ServerQueryBuilder.BuildRecommendationsQuery`) ✅ 2026-10-24. The answer is
 * shuffled among equally good servers, so two calls may differ. */
export function recommendationsUrl(countryId: number, cityId: number, limit = RECOMMENDATIONS_LIMIT): string {
  return (
    `https://api.nordvpn.com/v1/servers/recommendations?filters[country_id]=${countryId}&filters[country_city_id]=${cityId}` +
    `&filters[servers_groups][id]=${STANDARD_GROUP_ID}&filters[servers_technologies][id]=${WIREGUARD_TECH_ID}` +
    `&filters[servers_technologies][pivot][status]=online&limit=${limit}&${FIELDS_QUERY}`
  );
}

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
  /** Nord's numeric country and city ids, which the recommendations filter takes. */
  countryId?: number;
  cityId?: number;
  /** Nord's recommendation first (once asked), the rest least loaded first. */
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

/** Version 2 holds only standard-group servers (and the location ids). A version 1 cache
 * may hold Dedicated IP servers: it is refetched, and served only while that fails. */
export interface ServersCacheFile {
  version: 2;
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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** The server takes a NordLynx connection now: online, its `wireguard_udp` online, and in
 * the standard group. A field the payload lacks does not count against it. */
function isUsableServer(rec: Record<string, unknown>, wg: Record<string, unknown>): boolean {
  if (typeof rec.status === 'string' && rec.status !== 'online') return false;
  const pivot = wg.pivot as Record<string, unknown> | undefined;
  if (typeof pivot?.status === 'string' && pivot.status !== 'online') return false;
  if (Array.isArray(rec.groups) && !(rec.groups as Array<Record<string, unknown>>).some((g) => g?.id === STANDARD_GROUP_ID)) return false;
  return true;
}

/** One API server record → its location (without servers) and the server itself, or
 * undefined when the record is unusable. */
function parseServer(item: unknown): { location: Omit<NordLocation, 'servers'>; server: NordServer } | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const rec = item as Record<string, unknown>;
  const ip = str(rec.station);
  if (!IPV4_RE.test(ip)) return undefined;
  const loc = Array.isArray(rec.locations) ? (rec.locations[0] as Record<string, unknown> | undefined) : undefined;
  const country = (loc?.country ?? {}) as Record<string, unknown>;
  const cityRec = (country.city ?? {}) as Record<string, unknown>;
  const code = str(country.code).toUpperCase();
  const city = str(cityRec.name).trim();
  if (!/^[A-Z]{2}$/.test(code) || !city || !citySlug(city)) return undefined;
  const wg = Array.isArray(rec.technologies)
    ? (rec.technologies as Array<Record<string, unknown>>).find((t) => t?.identifier === 'wireguard_udp')
    : undefined;
  if (!wg || !isUsableServer(rec, wg)) return undefined;
  const meta = Array.isArray(wg.metadata) ? (wg.metadata as Array<Record<string, unknown>>) : [];
  const publicKey = str(meta.find((m) => m?.name === 'public_key')?.value);
  if (!WG_KEY_RE.test(publicKey)) return undefined;
  const load = typeof rec.load === 'number' && Number.isFinite(rec.load) ? rec.load : 100;
  const countryId = num(country.id);
  const cityId = num(cityRec.id);
  return {
    location: {
      key: nordLocationKey(code, city),
      country: code,
      countryName: str(country.name) || code,
      city,
      ...(countryId && cityId ? { countryId, cityId } : {}),
    },
    server: { ip, hostname: str(rec.hostname), load, publicKey, ...(isVirtualServer(rec) ? { virtual: true as const } : {}) },
  };
}

const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const byLoad = (a: NordServer, b: NordServer) => a.load - b.load || ipNum(a.ip) - ipNum(b.ip);

/**
 * The API payload → locations. Servers that are offline, outside the standard group, or
 * without an IPv4 station, a location, or a well-formed `wireguard_udp` public key are
 * skipped. Within a location servers are ordered by load, then by IP so the order is
 * deterministic; locations by key.
 */
export function parseServers(payload: unknown): NordLocation[] {
  if (!Array.isArray(payload)) throw new Error('nordvpn: servers payload is not an array');
  const byKey = new Map<string, NordLocation>();
  for (const item of payload) {
    const parsed = parseServer(item);
    if (!parsed) continue;
    let location = byKey.get(parsed.location.key);
    if (!location) {
      location = { ...parsed.location, servers: [] };
      byKey.set(location.key, location);
    }
    if (location.servers.some((s) => s.ip === parsed.server.ip)) continue;
    location.servers.push(parsed.server);
  }
  for (const l of byKey.values()) {
    l.servers.sort(byLoad);
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

/** Any cache this module wrote: version 1 (may hold unusable groups) or 2. */
async function readCache(cachePath: string): Promise<{ version: 1 | 2; fetchedAt: number; locations: NordLocation[] } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as { version?: unknown; fetchedAt?: unknown; locations?: unknown };
    if ((parsed?.version !== 1 && parsed?.version !== 2) || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.locations)) return undefined;
    return parsed as { version: 1 | 2; fetchedAt: number; locations: NordLocation[] };
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, cache: ServersCacheFile): Promise<void> {
  await writeFileAtomic(cachePath, JSON.stringify(cache));
}

/**
 * Synchronous, no-network read of the cached locations, whatever their age or version —
 * used by `bind()`, which must be deterministic (the Surfshark cluster cache precedent).
 * `undefined` when there is no readable cache.
 */
export function readServersCacheSync(cachePath: string): NordLocation[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { version?: unknown; locations?: unknown };
    return (parsed?.version === 1 || parsed?.version === 2) && Array.isArray(parsed.locations) ? (parsed.locations as NordLocation[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Fresh (within 12 h, version 2) locations, fetching and caching as needed; a stale or
 * version 1 cache beats none when the fetch fails. */
export async function getServers(opts: GetServersOptions): Promise<NordLocation[]> {
  const nowMs = (opts.now ?? Date.now)();
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const cached = await readCache(opts.cachePath);
  if (cached?.version === 2 && nowMs - cached.fetchedAt < SERVERS_CACHE_TTL_MS) return cached.locations;
  try {
    const res = await fetchImpl(SERVERS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`nordvpn: server list fetch failed with HTTP ${res.status}`);
    const locations = parseServers(await res.json());
    if (locations.length === 0) throw new Error('nordvpn: server list is empty');
    await writeCache(opts.cachePath, { version: 2, fetchedAt: nowMs, locations });
    return locations;
  } catch (err) {
    if (cached) return cached.locations;
    throw err;
  }
}

/**
 * Nord's recommended servers for `location`, best first: what the app connects to (it
 * takes the first). Only servers of that location that pass the same checks as the list.
 * Throws on a network or HTTP failure, and when the location lacks Nord's ids.
 */
export async function recommendServers(location: NordLocation, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<NordServer[]> {
  if (!location.countryId || !location.cityId) throw new Error(`nordvpn: no Nord ids for "${location.key}"`);
  const res = await fetchImpl(recommendationsUrl(location.countryId, location.cityId), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`nordvpn: recommendations failed with HTTP ${res.status}`);
  const payload = await res.json();
  if (!Array.isArray(payload)) throw new Error('nordvpn: recommendations payload is not an array');
  const out: NordServer[] = [];
  for (const item of payload) {
    const parsed = parseServer(item);
    if (parsed?.location.key === location.key && !out.some((s) => s.ip === parsed.server.ip)) out.push(parsed.server);
  }
  return out;
}

/**
 * Puts `recommended` first in the cached `locationKey`, in Nord's order and with their
 * fresh loads (adding any the list did not have yet); the location's other servers
 * follow, least loaded first. Keeps the cache's age, so the 12 h refresh still happens.
 * A no-op without a version 2 cache holding the location, or with nothing recommended.
 */
export async function applyRecommendations(cachePath: string, locationKey: string, recommended: NordServer[]): Promise<void> {
  if (recommended.length === 0) return;
  const cached = await readCache(cachePath);
  if (cached?.version !== 2) return;
  const location = cached.locations.find((l) => l.key === locationKey);
  if (!location) return;
  const first = new Set(recommended.map((s) => s.ip));
  location.servers = [...recommended, ...location.servers.filter((s) => !first.has(s.ip)).sort(byLoad)];
  if (location.servers.every((s) => s.virtual)) location.virtual = true;
  else delete location.virtual;
  await writeCache(cachePath, { version: 2, fetchedAt: cached.fetchedAt, locations: cached.locations });
}
