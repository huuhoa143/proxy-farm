import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sampleClusters from './fixtures/clusters.sample.json';
import { getClusters, parseClusters, CLUSTER_CACHE_TTL_MS } from './clusters';

describe('parseClusters', () => {
  it('parses the committed fixture and keeps only generic + static clusters', () => {
    const parsed = parseClusters(sampleClusters as unknown);
    expect(parsed.length).toBeGreaterThan(0);
    for (const c of parsed) {
      expect(['generic', 'static']).toContain(c.type);
    }
    // the fixture includes obfuscated entries; they must be filtered out
    const types = new Set((sampleClusters as any[]).map((c) => c.type));
    expect(types.has('obfuscated')).toBe(true); // sanity: fixture actually covers this case
  });

  it('extracts the fields bind() needs: connectionName, pubKey, countryCode, location', () => {
    const parsed = parseClusters(sampleClusters as unknown);
    const first = parsed[0];
    expect(typeof first.connectionName).toBe('string');
    expect(typeof first.pubKey).toBe('string');
    expect(typeof first.countryCode).toBe('string');
    expect(typeof first.location).toBe('string');
  });

  it('keeps the `virtual` tag (a location whose servers stand elsewhere)', () => {
    const parsed = parseClusters(sampleClusters as unknown);
    expect(parsed.find((c) => c.connectionName === 'al-tia.prod.surfshark.com')?.virtual).toBe(true);
    const untagged = (sampleClusters as Array<{ connectionName: string; tags?: string[] }>).filter((c) => !c.tags?.includes('virtual'));
    for (const c of untagged) expect(parsed.find((p) => p.connectionName === c.connectionName)?.virtual).toBeUndefined();
  });

  it('rejects a non-array payload', () => {
    expect(() => parseClusters({ not: 'an array' })).toThrow();
  });
});

describe('getClusters caching', () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), 'pf-surfshark-cache-'));
    cachePath = path.join(cacheDir, 'clusters.json');
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetches and writes the cache on a cold start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sampleClusters);
    const clusters = await getClusters({ cachePath, now: () => 1_000_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clusters.length).toBeGreaterThan(0);
  });

  it('reuses the cache within the TTL without re-fetching', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sampleClusters);
    let now = 1_000_000;
    await getClusters({ cachePath, now: () => now, fetchImpl });
    now += 60_000; // 1 minute later, well within 12h
    const clusters = await getClusters({ cachePath, now: () => now, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clusters.length).toBeGreaterThan(0);
  });

  it('re-fetches once the cache is older than 12h', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sampleClusters);
    let now = 1_000_000;
    await getClusters({ cachePath, now: () => now, fetchImpl });
    now += CLUSTER_CACHE_TTL_MS + 1;
    await getClusters({ cachePath, now: () => now, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to a stale cache if the fetch fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(sampleClusters).mockRejectedValueOnce(new Error('network down'));
    let now = 1_000_000;
    await getClusters({ cachePath, now: () => now, fetchImpl });
    now += CLUSTER_CACHE_TTL_MS + 1;
    const clusters = await getClusters({ cachePath, now: () => now, fetchImpl });
    expect(clusters.length).toBeGreaterThan(0);
  });
});
