/**
 * HMA catalog helpers. The on-disk catalog is `{key, country, city, ips: [{ip, firstSeen,
 * lastOk, lastSeen}]}` per location; `mergeCatalog()` folds a freshly discovered feed
 * (se-platform/discover-source.ts) into the current catalog: new IPs are appended under
 * their location's key, deduped by IP, and existing IP entries keep whatever `lastOk`
 * history they carry (a feed's stub never overwrites them) while their `lastSeen` is
 * bumped to the feed's time.
 *
 * With `opts.staleSec`, a location the feed TOUCHED (so we have fresh truth for it) drops
 * any IP the feed did not return and that no live port is holding (`opts.protect`) once it
 * has gone unseen that long — so a dynamic provider's catalog follows the backend's
 * rotating gateways instead of accumulating dead IPs forever.
 */
import type { Catalog, CatalogLocation, CatalogIp } from '../types';

export interface MergeOptions {
  /** Drop a touched location's unseen, unheld IPs once their `lastSeen` is older than this
   * many seconds before the feed's time. Omit to keep the old accumulate-only behaviour. */
  staleSec?: number;
  /** IPs a live port currently holds — never evicted, however stale. */
  protect?: ReadonlySet<string>;
}

function seenAt(ip: CatalogIp): number {
  return ip.lastSeen ?? ip.firstSeen;
}

export function mergeCatalog(current: Catalog, feed: Catalog, opts: MergeOptions = {}): Catalog {
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
    const known = new Map(existing.ips.map((ip) => [ip.ip, ip]));
    for (const ip of feedLoc.ips) {
      const prev = known.get(ip.ip);
      if (!prev) {
        existing.ips.push({ ...ip });
        known.set(ip.ip, ip);
      } else {
        // An IP already known to `current` keeps its firstSeen/lastOk; only its freshness
        // (lastSeen) advances to this feed's time.
        prev.lastSeen = Math.max(seenAt(prev), ip.lastSeen ?? feed.fetched);
      }
    }
    if (opts.staleSec !== undefined) {
      const cutoff = feed.fetched - opts.staleSec;
      existing.ips = existing.ips.filter((ip) => seenAt(ip) >= cutoff || opts.protect?.has(ip.ip));
    }
  }

  return { fetched: feed.fetched, locations: Array.from(byKey.values()) };
}
