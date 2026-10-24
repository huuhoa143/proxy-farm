import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiServer, NORD_IDS, PK_HANOI, PK_HCMC, samplePayload } from './fixtures/sample-servers';
import {
  applyRecommendations,
  citySlug,
  getServers,
  nordLocationKey,
  parseServers,
  readServersCacheSync,
  recommendationsUrl,
  recommendServers,
  SERVERS_CACHE_TTL_MS,
  SERVERS_URL,
  type FetchLike,
} from './servers';

function okFetch(payload: unknown = samplePayload()) {
  return vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => payload }));
}

describe('nordvpn location keys', () => {
  it('slugs the city: upper case, accents folded, non-alphanumerics to dashes', () => {
    expect(citySlug('Ho Chi Minh City')).toBe('HO-CHI-MINH-CITY');
    expect(citySlug('São Paulo')).toBe('SAO-PAULO');
    expect(nordLocationKey('vn', 'Hanoi')).toBe('nordvpn:VN-HANOI');
  });
});

describe('parseServers', () => {
  it('groups NordLynx servers into one location per (country, city), least loaded first', () => {
    const locations = parseServers(samplePayload());
    expect(locations.map((l) => l.key)).toEqual(['nordvpn:BR-SAO-PAULO', 'nordvpn:VN-HANOI', 'nordvpn:VN-HO-CHI-MINH-CITY']);
    const hanoi = locations.find((l) => l.key === 'nordvpn:VN-HANOI')!;
    expect(hanoi).toMatchObject({ country: 'VN', countryName: 'Vietnam', city: 'Hanoi' });
    expect(hanoi.servers.map((s) => s.ip)).toEqual(['192.0.2.1', '192.0.2.3']);
    expect(hanoi.servers.every((s) => s.publicKey === PK_HANOI)).toBe(true);
    // equal load: ordered by IP, numerically
    const hcmc = locations.find((l) => l.key === 'nordvpn:VN-HO-CHI-MINH-CITY')!;
    expect(hcmc.servers.map((s) => s.ip)).toEqual(['198.51.100.45', '198.51.100.111', '198.51.100.67']);
    expect(hcmc.servers[0]).toEqual({ ip: '198.51.100.45', hostname: 'vn56.nordvpn.com', load: 12, publicKey: PK_HCMC, virtual: true });
  });

  it("reads Nord's virtual_location flag: per server, and a location whose servers all carry it", () => {
    const locations = parseServers(samplePayload());
    expect(locations.find((l) => l.key === 'nordvpn:VN-HANOI')!.virtual).toBe(true);
    const sao = locations.find((l) => l.key === 'nordvpn:BR-SAO-PAULO')!;
    expect(sao.virtual).toBeUndefined();
    expect(sao.servers[0].virtual).toBeUndefined();
    expect(SERVERS_URL).toContain('fields[servers.specifications.identifier]');
  });

  it('keeps only online servers of the standard group (no Dedicated IP, Double VPN, offline)', () => {
    const hanoi = parseServers(samplePayload()).find((l) => l.key === 'nordvpn:VN-HANOI')!;
    // vn95 (Dedicated IP), vn94 (Double VPN), vn93 (offline), vn92 (WireGuard down) are gone
    expect(hanoi.servers.map((s) => s.hostname)).toEqual(['vn52.nordvpn.com', 'vn53.nordvpn.com']);
    expect(SERVERS_URL).toContain('filters[servers_groups][id]=11');
    expect(SERVERS_URL).toContain('fields[servers.groups.id]');
    expect(SERVERS_URL).toContain('fields[servers.technologies.pivot.status]');
  });

  it("keeps Nord's numeric country and city ids, which recommendations filter on", () => {
    const hanoi = parseServers(samplePayload()).find((l) => l.key === 'nordvpn:VN-HANOI')!;
    expect(hanoi).toMatchObject(NORD_IDS.Hanoi);
    // a record without groups/status (an older answer) is not held against the server
    const bare = apiServer('x1.nordvpn.com', '192.0.2.50', 5, 'VN', 'Vietnam', 'Hanoi', PK_HANOI) as Record<string, unknown>;
    delete bare.groups;
    delete bare.status;
    expect(parseServers([bare])[0].servers).toHaveLength(1);
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseServers({ errors: 'nope' })).toThrow();
  });
});

describe('getServers (12 h disk cache)', () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pf-nordvpn-servers-'));
    cachePath = path.join(dir, 'cache', 'nordvpn-servers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fetches the whole trimmed NordLynx list in one request and caches it', async () => {
    const fetchImpl = okFetch();
    const locations = await getServers({ cachePath, now: () => 1_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toBe(SERVERS_URL);
    expect(url).toContain('filters[servers_technologies][identifier]=wireguard_udp');
    expect(url).toContain('fields[servers.technologies.metadata]');
    expect(locations).toHaveLength(3);
    expect(readServersCacheSync(cachePath)).toEqual(locations);
  });

  it('serves the cache within 12 h and refreshes after', async () => {
    const fetchImpl = okFetch();
    let now = 1_000;
    await getServers({ cachePath, now: () => now, fetchImpl });
    now += SERVERS_CACHE_TTL_MS - 1;
    await getServers({ cachePath, now: () => now, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    await getServers({ cachePath, now: () => now, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a stale cache when a refresh fails (network error, HTTP error, empty list)', async () => {
    let now = 1_000;
    const first = await getServers({ cachePath, now: () => now, fetchImpl: okFetch() });
    now += SERVERS_CACHE_TTL_MS + 1;
    const failures: FetchLike[] = [
      async () => {
        throw new Error('offline');
      },
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
      async () => ({ ok: true, status: 200, json: async () => [] }),
    ];
    for (const fetchImpl of failures) expect(await getServers({ cachePath, now: () => now, fetchImpl })).toEqual(first);
  });

  it('throws with no cache and no network', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(getServers({ cachePath, fetchImpl })).rejects.toThrow('offline');
  });

  it('refetches a version 1 cache (it may hold Dedicated IP servers), and serves it only offline', async () => {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const old = [{ key: 'nordvpn:VN-HANOI', country: 'VN', countryName: 'Vietnam', city: 'Hanoi', servers: [] }];
    writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: 1_000, locations: old }));
    expect(readServersCacheSync(cachePath)).toEqual(old); // bind() can still read it
    const offline: FetchLike = async () => {
      throw new Error('offline');
    };
    expect(await getServers({ cachePath, now: () => 1_001, fetchImpl: offline })).toEqual(old);
    const fetchImpl = okFetch();
    expect(await getServers({ cachePath, now: () => 1_001, fetchImpl })).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores an unreadable or foreign cache file', async () => {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), clusters: [] }));
    expect(readServersCacheSync(cachePath)).toBeUndefined();
    const fetchImpl = okFetch();
    await getServers({ cachePath, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('recommendations', () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pf-nordvpn-rec-'));
    cachePath = path.join(dir, 'cache', 'nordvpn-servers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const hcmcIds = NORD_IDS['Ho Chi Minh City'];
  const hcmcOf = () => parseServers(samplePayload()).find((l) => l.key === 'nordvpn:VN-HO-CHI-MINH-CITY')!;

  it('asks with the filters the app sends: location ids, standard group, NordLynx, online', () => {
    const url = recommendationsUrl(hcmcIds.countryId, hcmcIds.cityId);
    expect(url.startsWith('https://api.nordvpn.com/v1/servers/recommendations?')).toBe(true);
    for (const part of [
      `filters[country_id]=${hcmcIds.countryId}`,
      `filters[country_city_id]=${hcmcIds.cityId}`,
      'filters[servers_groups][id]=11',
      'filters[servers_technologies][id]=35',
      'filters[servers_technologies][pivot][status]=online',
      'limit=30',
      'fields[servers.technologies.metadata]',
    ]) {
      expect(url).toContain(part);
    }
  });

  it("recommendServers keeps Nord's order and drops servers of other locations or unusable ones", async () => {
    const answer = [
      apiServer('vn57.nordvpn.com', '198.51.100.67', 9, 'VN', 'Vietnam', 'Ho Chi Minh City', PK_HCMC, true),
      apiServer('vn52.nordvpn.com', '192.0.2.1', 9, 'VN', 'Vietnam', 'Hanoi', PK_HANOI, true),
      apiServer('vn58.nordvpn.com', '198.51.100.68', 3, 'VN', 'Vietnam', 'Ho Chi Minh City', PK_HCMC, true, { groups: [9] }),
      apiServer('vn56.nordvpn.com', '198.51.100.45', 4, 'VN', 'Vietnam', 'Ho Chi Minh City', PK_HCMC, true),
    ];
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => answer }));
    const servers = await recommendServers(hcmcOf(), fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(recommendationsUrl(hcmcIds.countryId, hcmcIds.cityId));
    expect(servers.map((s) => [s.ip, s.load])).toEqual([
      ['198.51.100.67', 9],
      ['198.51.100.45', 4],
    ]);
  });

  it('recommendServers throws on an HTTP error and without Nord ids', async () => {
    await expect(recommendServers(hcmcOf(), async () => ({ ok: false, status: 500, json: async () => ({}) }))).rejects.toThrow('HTTP 500');
    await expect(recommendServers({ ...hcmcOf(), countryId: undefined }, okFetch([]))).rejects.toThrow('no Nord ids');
  });

  it('applyRecommendations puts them first, the rest by load, and keeps the cache age', async () => {
    await getServers({ cachePath, now: () => 5_000, fetchImpl: okFetch() });
    const pick = { ip: '198.51.100.67', hostname: 'vn57.nordvpn.com', load: 3, publicKey: PK_HCMC, virtual: true as const };
    await applyRecommendations(cachePath, 'nordvpn:VN-HO-CHI-MINH-CITY', [pick]);
    const hcmc = readServersCacheSync(cachePath)!.find((l) => l.key === 'nordvpn:VN-HO-CHI-MINH-CITY')!;
    expect(hcmc.servers.map((s) => s.ip)).toEqual(['198.51.100.67', '198.51.100.45', '198.51.100.111']);
    expect(hcmc.servers[0].load).toBe(3);
    // the 12 h window still runs from the original fetch
    const fetchImpl = okFetch();
    await getServers({ cachePath, now: () => 5_000 + SERVERS_CACHE_TTL_MS - 1, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('applyRecommendations leaves the cache alone for nothing, an unknown location or no cache', async () => {
    const one = [{ ip: '192.0.2.1', hostname: 'vn52.nordvpn.com', load: 1, publicKey: PK_HANOI }];
    await applyRecommendations(cachePath, 'nordvpn:VN-HANOI', one);
    expect(readServersCacheSync(cachePath)).toBeUndefined();
    await getServers({ cachePath, now: () => 5_000, fetchImpl: okFetch() });
    const before = readServersCacheSync(cachePath);
    await applyRecommendations(cachePath, 'nordvpn:VN-HANOI', []);
    await applyRecommendations(cachePath, 'nordvpn:XX-NOWHERE', one);
    expect(readServersCacheSync(cachePath)).toEqual(before);
  });
});
