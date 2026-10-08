/**
 * HMA catalog (spec §5.1): `{key, country, city, ips: [{ip, firstSeen, lastOk}]}`.
 *
 * `loadSeed()` reads the bundled seed file (a verbatim copy of PR #2's
 * `hma-ovpn-seed.json`, one IP per location in its own `{key, country, ip,
 * ...}` shape) and converts it to the catalog schema above.
 *
 * `mergeCatalog()` folds a freshly fetched feed into the current on-disk
 * catalog: new IPs are appended under their location's key, deduped by IP,
 * and existing IP entries (with whatever `lastOk` history they carry) are
 * never overwritten by a feed's stub entry for the same IP.
 */
import { readFile } from 'node:fs/promises';
import { resourcePath } from '../../resources-root';
import type { Catalog, CatalogLocation } from '../types';

interface SeedLocation {
  key: string;
  country: string;
  countryName?: string;
  city: string;
  /** Primary server (the original PR #2 seed shape). */
  ip: string;
  /** Every server of the location verified to accept HMA device credentials, best
   * first. Optional; when present it supersedes `ip` (scripts/hma-scan-servers.ts). */
  ips?: string[];
  port?: number;
  proto?: string;
}

interface SeedFile {
  fetched: number;
  locations: SeedLocation[];
}

export async function loadSeed(seedPath: string = resourcePath('catalogs', 'hma-ovpn-seed.json')): Promise<Catalog> {
  const text = await readFile(seedPath, 'utf8');
  const seed = JSON.parse(text) as SeedFile;
  return {
    fetched: seed.fetched,
    locations: seed.locations.map((loc) => ({
      key: loc.key,
      country: loc.country,
      city: loc.city,
      ips: [...new Set(loc.ips?.length ? loc.ips : [loc.ip])].map((ip) => ({ ip, firstSeen: seed.fetched, lastOk: null })),
    })),
  };
}

export function mergeCatalog(current: Catalog, feed: Catalog): Catalog {
  const byKey = new Map<string, CatalogLocation>();
  for (const loc of current.locations) {
    byKey.set(loc.key, { ...loc, ips: loc.ips.map((ip) => ({ ...ip })) });
  }

  for (const feedLoc of feed.locations) {
    const existing = byKey.get(feedLoc.key);
    if (!existing) {
      byKey.set(feedLoc.key, { ...feedLoc, ips: feedLoc.ips.map((ip) => ({ ...ip })) });
      continue;
    }
    const knownIps = new Set(existing.ips.map((ip) => ip.ip));
    for (const ip of feedLoc.ips) {
      if (!knownIps.has(ip.ip)) {
        existing.ips.push({ ...ip });
        knownIps.add(ip.ip);
      }
      // an IP already known to `current` keeps its own firstSeen/lastOk —
      // the feed's entry for the same IP is never used to overwrite it.
    }
  }

  return { fetched: feed.fetched, locations: Array.from(byKey.values()) };
}
