/**
 * Turns se-platform `discover` results into catalog feed entries the existing
 * `mergeCatalog` folds into the on-disk HMA catalog (providers/hma/catalog.ts). Only the
 * OpenVPN gateways are kept — that is the protocol proxy-farm's engine connects HMA with
 * (username/password), and their IPs accumulate over repeated discovers into the large,
 * fresh, rotating pool the real app shows.
 */
import { discover } from './client';
import type { TokenMinter } from './device';
import type { Catalog, CatalogLocation } from '../../types';
import type { SeFetch, SeGateway } from './types';

/** A gateway's city from its location_key `CC-REGION-CITY…`, or the country as a fallback. */
function cityOf(gw: SeGateway): string {
  return gw.city || gw.locationKey;
}

/** Group OpenVPN gateways by their location_key into catalog locations. */
export function gatewaysToCatalog(gateways: SeGateway[], fetchedSec: number): Catalog {
  const byKey = new Map<string, CatalogLocation>();
  for (const gw of gateways) {
    if (gw.protocol !== 'openvpn') continue;
    const key = gw.locationKey;
    if (!key) continue;
    let loc = byKey.get(key);
    if (!loc) {
      loc = { key, country: gw.countryCode, city: cityOf(gw), ips: [] };
      byKey.set(key, loc);
    }
    if (!loc.ips.some((e) => e.ip === gw.ip)) {
      loc.ips.push({ ip: gw.ip, firstSeen: fetchedSec, lastOk: null, lastSeen: fetchedSec });
    }
  }
  return { fetched: fetchedSec, locations: [...byKey.values()] };
}

/** Discover each location_key once and return a single feed catalog of every OpenVPN IP
 * seen. Runs up to `concurrency` discovers at a time (default 1 = sequential, gentle); a
 * failed location is skipped, not fatal. */
export async function discoverFeed(
  locationKeys: string[],
  minter: TokenMinter,
  net: SeFetch,
  opts: { now?: () => number; tenant: string; concurrency?: number } = { tenant: '' },
): Promise<Catalog> {
  const now = opts.now ?? Date.now;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const token = await minter.getToken();
  const all: SeGateway[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < locationKeys.length) {
      const key = locationKeys[next++];
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await discover({ locationKey: key, tenantId: opts.tenant, token }, net);
        all.push(...result.gateways);
      } catch {
        // skip this location; discovering the rest is still useful
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, locationKeys.length || 1) }, () => worker()));
  return gatewaysToCatalog(all, Math.floor(now() / 1000));
}
