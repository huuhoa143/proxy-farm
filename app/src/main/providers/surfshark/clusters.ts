/**
 * Surfshark cluster list (spec §5.3): fetched from the public
 * `https://api.surfshark.com/v4/server/clusters/all`, cached on disk for
 * 12h (cache path injectable so the controller can point it at `userData`
 * and tests can point it at a tmp dir).
 *
 * Only `generic` and `static` cluster types are kept — `obfuscated` isn't a
 * WireGuard endpoint and isn't in scope here.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CLUSTERS_URL = 'https://api.surfshark.com/v4/server/clusters/all';
export const CLUSTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface SurfsharkCluster {
  type: 'generic' | 'static';
  countryCode: string;
  country: string;
  location: string;
  connectionName: string;
  pubKey: string;
  /** Tagged `virtual`: the servers stand elsewhere and present as this country. */
  virtual?: true;
}

export interface CacheFile {
  fetchedAt: number;
  clusters: SurfsharkCluster[];
}

export function parseClusters(payload: unknown): SurfsharkCluster[] {
  if (!Array.isArray(payload)) {
    throw new Error('surfshark: clusters payload is not an array');
  }
  const out: SurfsharkCluster[] = [];
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type !== 'generic' && rec.type !== 'static') continue;
    if (typeof rec.connectionName !== 'string' || typeof rec.pubKey !== 'string') continue;
    out.push({
      type: rec.type,
      countryCode: String(rec.countryCode ?? ''),
      country: String(rec.country ?? ''),
      location: String(rec.location ?? ''),
      connectionName: rec.connectionName,
      pubKey: rec.pubKey,
      ...(Array.isArray(rec.tags) && rec.tags.includes('virtual') ? { virtual: true as const } : {}),
    });
  }
  return out;
}

export interface GetClustersOptions {
  cachePath: string;
  now?: () => number;
  fetchImpl?: (url: string) => Promise<unknown>;
}

async function defaultFetchImpl(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`surfshark: clusters fetch failed with HTTP ${res.status}`);
  }
  return res.json();
}

async function readCache(cachePath: string): Promise<CacheFile | undefined> {
  try {
    const text = await readFile(cachePath, 'utf8');
    return JSON.parse(text) as CacheFile;
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache), 'utf8');
}

/**
 * Synchronous, no-network read of whatever is currently on disk — used by
 * `surfshark/index.ts#bind()`, which must be deterministic (same precedent
 * as the hma/zoogvpn CA files being read with `readFileSync`). Returns
 * whatever is cached regardless of its age: staleness is a health-module
 * display concern ("the catalog shows its age"), not a reason for a pure
 * `bind()` call to fail. Returns `undefined` if there is no cache yet or it
 * can't be parsed.
 */
export function readClustersCacheSync(cachePath: string): SurfsharkCluster[] | undefined {
  try {
    const text = readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(text) as CacheFile;
    return cache.clusters;
  } catch {
    return undefined;
  }
}

/** Returns a fresh (within 12h) cluster list, fetching and caching as needed. */
export async function getClusters(opts: GetClustersOptions): Promise<SurfsharkCluster[]> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
  const nowMs = now();

  const cached = await readCache(opts.cachePath);
  if (cached && nowMs - cached.fetchedAt < CLUSTER_CACHE_TTL_MS) {
    return cached.clusters;
  }

  try {
    const payload = await fetchImpl(CLUSTERS_URL);
    const clusters = parseClusters(payload);
    await writeCache(opts.cachePath, { fetchedAt: nowMs, clusters });
    return clusters;
  } catch (err) {
    if (cached) {
      // Stale cache beats no cache: a 12h-old server list is still mostly
      // usable, per spec's "the catalog shows its age / nothing is blocked".
      return cached.clusters;
    }
    throw err;
  }
}
