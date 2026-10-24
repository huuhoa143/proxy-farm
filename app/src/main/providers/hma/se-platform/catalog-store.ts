/**
 * The se-platform location catalog for the HMA provider: the geos list (what locations
 * exist, 12 h cached) plus an accumulating pool of OpenVPN IPs per location, filled by
 * repeated `discover` calls and folded in with the existing `mergeCatalog`.
 *
 * targets() reads `snapshot()` — a fast, synchronous view of the current pool — and kicks
 * a non-blocking `refresh()` so the next read has fresher/more IPs. One refresh runs at a
 * time; each covers a round-robin batch of locations, so over a few calls the whole map
 * fills and keeps rotating, the way the real app's pool does.
 */
import { readFile } from 'node:fs/promises';
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
/** How many locations one refresh discovers (sequential, ~0.3 s each). */
const REFRESH_BATCH = 8;
/** Concurrency for the one-time country-sweep warm-up (fills the whole list fast). */
const WARMUP_CONCURRENCY = 8;
/** Minimum gap between refreshes kicked by targets(). */
const REFRESH_MIN_GAP_MS = 20 * 1000;

interface GeosCache {
  fetchedAt: number;
  geos: SeGeoCountry[];
}

export interface SeCatalogStore {
  /** Ensure the geos list is loaded (fetch + 12 h cache). */
  geos(ctx: RefreshCtx): Promise<SeGeoCountry[]>;
  /** The current accumulated OpenVPN-IP catalog (sync, no network). */
  snapshot(): Catalog;
  /** Discover the next round-robin batch and merge it in. Safe to call often; it
   * self-throttles and never runs two at once. Returns the in-flight refresh promise when
   * it started one (so tests can await it), or undefined when throttled/skipped. Production
   * callers ignore the return — it is fire-and-forget. */
  kickRefresh(ctx: RefreshCtx): Promise<void> | undefined;
  /** Discover ONE location right now (not throttled) and merge its fresh IPs — for a
   * user Change IP / Add port on that location. */
  refreshOne(ctx: RefreshCtx, locationKey: string): Promise<void>;
  /** Discover EVERY country now (concurrently) and merge — a user "Load locations" sweep.
   * Resolves when the sweep finishes. */
  refreshAll(ctx: RefreshCtx): Promise<void>;
}

export interface RefreshCtx {
  minter: TokenMinter;
  tenant: string;
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
  let refreshing = false;
  let lastRefresh = 0;
  let cursor = 0;
  let warmedUp = false;

  async function loadGeos(ctx: RefreshCtx): Promise<SeGeoCountry[]> {
    if (geosCache && now() - geosCache.fetchedAt < GEOS_TTL_MS) return geosCache.geos;
    geosInflight ??= (async () => {
      const token = await ctx.minter.getToken();
      const geos = await fetchGeos({ tenantId: ctx.tenant, token }, deps.net);
      geosCache = { fetchedAt: now(), geos };
      await writeFileAtomic(deps.geosPath, JSON.stringify(geosCache)).catch(() => undefined);
      return geos;
    })().finally(() => {
      geosInflight = undefined;
    });
    return geosInflight;
  }

  /** Every selectable location_key from geos, for round-robin discovery. Country keys come
   * first (one discover returns gateways across several of that country's cities, so a few
   * refreshes already spread locations worldwide); city keys follow for finer coverage. */
  function allKeys(): string[] {
    const geos = geosCache?.geos ?? [];
    const countries = geos.map((c) => c.locationKey);
    const cities: string[] = [];
    for (const c of geos) for (const city of c.cities) if (city.active) cities.push(city.locationKey);
    return [...countries, ...cities];
  }

  async function discoverAndMerge(ctx: RefreshCtx, keys: string[], concurrency = 1): Promise<void> {
    const feed = await discoverFeed(keys, ctx.minter, deps.net, { tenant: ctx.tenant, now, concurrency });
    if (feed.locations.length === 0) return;
    catalog = mergeCatalog(catalog, feed, { staleSec: STALE_IP_TTL_SEC, protect: deps.heldIps?.() });
    await writeFileAtomic(deps.catalogPath, JSON.stringify(catalog)).catch(() => undefined);
    deps.onChange?.();
  }

  async function doRefresh(ctx: RefreshCtx): Promise<void> {
    await loadGeos(ctx).catch(() => undefined);
    // First pass: sweep every COUNTRY key concurrently so the whole country list appears
    // quickly (a country discover returns gateways across several of its cities). Later
    // passes round-robin all keys (cities too) to broaden and keep the pool fresh.
    if (!warmedUp) {
      const countries = (geosCache?.geos ?? []).map((c) => c.locationKey);
      if (countries.length > 0) {
        warmedUp = true;
        await discoverAndMerge(ctx, countries, WARMUP_CONCURRENCY);
        return;
      }
    }
    const keys = allKeys();
    if (keys.length === 0) return;
    const batch: string[] = [];
    for (let i = 0; i < REFRESH_BATCH && i < keys.length; i++) {
      batch.push(keys[cursor % keys.length]);
      cursor++;
    }
    await discoverAndMerge(ctx, batch);
  }

  return {
    geos: (ctx) => loadGeos(ctx),
    snapshot: () => catalog,
    kickRefresh(ctx) {
      if (refreshing || now() - lastRefresh < REFRESH_MIN_GAP_MS) return undefined;
      refreshing = true;
      lastRefresh = now();
      return doRefresh(ctx)
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    },
    refreshOne(ctx, locationKey) {
      return discoverAndMerge(ctx, [locationKey]).catch(() => undefined);
    },
    async refreshAll(ctx) {
      await loadGeos(ctx).catch(() => undefined);
      const countries = (geosCache?.geos ?? []).map((c) => c.locationKey);
      warmedUp = true;
      if (countries.length > 0) await discoverAndMerge(ctx, countries, WARMUP_CONCURRENCY).catch(() => undefined);
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
