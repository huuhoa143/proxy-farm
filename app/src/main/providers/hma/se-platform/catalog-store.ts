/**
 * The se-platform location catalog for the HMA provider: the geos list (what locations
 * exist, 12 h cached) plus an accumulating pool of OpenVPN IPs per location, filled by
 * `discover` calls and folded in with the existing `mergeCatalog`.
 *
 * Discovery is on demand only, the way the real app uses the API: it discovers ONE location
 * when it connects or shuffles its IP, and never sweeps the map. So a location gets its
 * gateways when a port is added there, on Change IP, when its server list is opened, and on
 * the controller's slow re-discovery of locations that hold a live port — never in bulk
 * behind the user's back. targets() reads `snapshot()`, a synchronous view of the pool.
 */
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../../../store/atomic-write';
import { mergeCatalog } from '../catalog';
import { fetchGeos } from './client';
import { discoverFeed } from './discover-source';
import type { TokenMinter } from './device';
import type { Catalog } from '../../types';
import type { SeFetch, SeGeoCountry } from './types';

const GEOS_TTL_MS = 12 * 60 * 60 * 1000;
/** A discovered IP a later discover of the same location stops returning is dropped once it
 * has gone unseen this long (unless a live port holds it) — the backend rotated it out. */
const STALE_IP_TTL_SEC = 60 * 60;

interface GeosCache {
  fetchedAt: number;
  geos: SeGeoCountry[];
}

export interface SeCatalogStore {
  /** The geos list (fetched when missing or older than 12 h; `force` re-fetches now). */
  geos(ctx: GeosCtx, opts?: { force?: boolean }): Promise<SeGeoCountry[]>;
  /** The current accumulated OpenVPN-IP catalog (sync, no network). */
  snapshot(): Catalog;
  /** Discover ONE location right now and merge its fresh IPs — for a port being added
   * there, a Change IP, its server list being opened, or the slow re-discovery of a
   * location with a live port. */
  refreshOne(ctx: RefreshCtx, locationKey: string): Promise<void>;
}

export interface GeosCtx {
  tenant: string;
}

export interface RefreshCtx extends GeosCtx {
  minter: TokenMinter;
}

export interface SeCatalogDeps {
  geosPath: string;
  catalogPath: string;
  net: SeFetch;
  now?: () => number;
  onChange?: () => void;
  /** IPs a live port currently holds; never evicted by stale-pruning however old. */
  heldIps?: () => ReadonlySet<string>;
}

export function createSeCatalogStore(deps: SeCatalogDeps): SeCatalogStore {
  const now = deps.now ?? Date.now;
  let catalog: Catalog = readJsonSync<Catalog>(deps.catalogPath) ?? { fetched: 0, locations: [] };
  let geosCache: GeosCache | undefined = readJsonSync<GeosCache>(deps.geosPath);
  let geosInflight: Promise<SeGeoCountry[]> | undefined;

  async function loadGeos(ctx: GeosCtx, force = false): Promise<SeGeoCountry[]> {
    if (!force && geosCache && now() - geosCache.fetchedAt < GEOS_TTL_MS) return geosCache.geos;
    geosInflight ??= (async () => {
      const geos = await fetchGeos({ tenantId: ctx.tenant }, deps.net);
      geosCache = { fetchedAt: now(), geos };
      await writeFileAtomic(deps.geosPath, JSON.stringify(geosCache)).catch(() => undefined);
      return geos;
    })().finally(() => {
      geosInflight = undefined;
    });
    return geosInflight;
  }

  async function discoverAndMerge(ctx: RefreshCtx, keys: string[]): Promise<void> {
    const feed = await discoverFeed(keys, ctx.minter, deps.net, { tenant: ctx.tenant, now });
    if (feed.locations.length === 0) return;
    catalog = mergeCatalog(catalog, feed, { staleSec: STALE_IP_TTL_SEC, protect: deps.heldIps?.() });
    await writeFileAtomic(deps.catalogPath, JSON.stringify(catalog)).catch(() => undefined);
    deps.onChange?.();
  }

  return {
    geos: (ctx, opts) => loadGeos(ctx, opts?.force),
    snapshot: () => catalog,
    refreshOne(ctx, locationKey) {
      return discoverAndMerge(ctx, [locationKey]).catch(() => undefined);
    },
  };
}

function readJsonSync<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
