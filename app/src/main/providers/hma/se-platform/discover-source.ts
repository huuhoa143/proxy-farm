/**
 * Turns se-platform `discover` results into catalog feed entries the existing
 * `mergeCatalog` folds into the on-disk HMA catalog (providers/hma/catalog.ts). Only the
 * OpenVPN gateways are kept — that is the protocol proxy-farm's engine connects HMA with
 * (username/password), and their IPs accumulate over repeated discovers into the large,
 * fresh, rotating pool the real app shows.
 */
import { discover, SeError } from './client';
import { withToken, type TokenMinter } from './device';
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

/** Discover each location_key once, one after another, and return a single feed catalog of
 * every OpenVPN IP seen. A failed location is skipped, not fatal; a rejected token is
 * re-minted once (see `withToken`) instead of failing every location until it expires. */
export async function discoverFeed(
  locationKeys: string[],
  minter: TokenMinter,
  net: SeFetch,
  opts: { now?: () => number; tenant: string } = { tenant: '' },
): Promise<Catalog> {
  const now = opts.now ?? Date.now;
  await minter.getToken(); // no token at all: fail the whole feed once, not per location
  const all: SeGateway[] = [];
  for (const key of locationKeys) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await withToken(minter, (token) => discover({ locationKey: key, tenantId: opts.tenant, token }, net));
      all.push(...result.gateways);
    } catch (err) {
      // Offline, or the device's token can't be had even after a re-mint: the remaining
      // locations would fail the same way, so stop instead of hammering the API.
      if (err instanceof SeError && (err.kind === 'network' || err.kind === 'unauthorized' || err.kind === 'gone')) break;
      // otherwise skip this location; discovering the rest is still useful
    }
  }
  return gatewaysToCatalog(all, Math.floor(now() / 1000));
}
