import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PK_HANOI, PK_HCMC, samplePayload } from './fixtures/sample-servers';
import { citySlug, getServers, nordLocationKey, parseServers, readServersCacheSync, SERVERS_CACHE_TTL_MS, SERVERS_URL, type FetchLike } from './servers';

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

  it('ignores an unreadable or foreign cache file', async () => {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), clusters: [] }));
    expect(readServersCacheSync(cachePath)).toBeUndefined();
    const fetchImpl = okFetch();
    await getServers({ cachePath, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
