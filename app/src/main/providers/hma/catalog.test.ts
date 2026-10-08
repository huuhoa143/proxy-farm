import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSeed, mergeCatalog } from './catalog';

async function seedFile(locations: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pf-seed-'));
  const file = path.join(dir, 'seed.json');
  await writeFile(file, JSON.stringify({ fetched: 1700000000, locations }));
  return file;
}

describe('loadSeed', () => {
  it('reads the bundled hma-ovpn-seed.json: every location has at least one unique IP, none confirmed yet', async () => {
    const catalog = await loadSeed();
    expect(catalog.locations.length).toBe(115);
    const abuDhabi = catalog.locations.find((l) => l.key === 'AE-1-ABU-DHABI');
    expect(abuDhabi).toMatchObject({ country: 'AE', city: 'Abu Dhabi' });
    for (const loc of catalog.locations) {
      expect(loc.ips.length).toBeGreaterThan(0);
      expect(new Set(loc.ips.map((i) => i.ip)).size).toBe(loc.ips.length);
      for (const ip of loc.ips) {
        expect(ip.lastOk).toBeNull();
        expect(ip.firstSeen).toBe(catalog.fetched);
      }
    }
  });

  it('a legacy single-ip entry becomes a one-IP location', async () => {
    const catalog = await loadSeed(await seedFile([{ key: 'X-1', country: 'XX', city: 'X', ip: '10.0.0.1' }]));
    expect(catalog.locations[0].ips).toEqual([{ ip: '10.0.0.1', firstSeen: 1700000000, lastOk: null }]);
  });

  it('an `ips` list supersedes `ip`, keeps its order, and drops duplicates', async () => {
    const catalog = await loadSeed(
      await seedFile([{ key: 'X-1', country: 'XX', city: 'X', ip: '10.0.0.9', ips: ['10.0.0.2', '10.0.0.3', '10.0.0.2'] }]),
    );
    expect(catalog.locations[0].ips.map((i) => i.ip)).toEqual(['10.0.0.2', '10.0.0.3']);
  });
});

describe('mergeCatalog', () => {
  it('accumulates a new IP under an existing key', () => {
    const current = {
      fetched: 1000,
      locations: [
        {
          key: 'JP-40-TOKYO-ULT',
          country: 'JP',
          city: 'Tokyo',
          ips: [{ ip: '1.2.3.4', firstSeen: 1000, lastOk: null }],
        },
      ],
    };
    const feed = {
      fetched: 2000,
      locations: [
        {
          key: 'JP-40-TOKYO-ULT',
          country: 'JP',
          city: 'Tokyo',
          ips: [{ ip: '5.6.7.8', firstSeen: 2000, lastOk: null }],
        },
      ],
    };

    const merged = mergeCatalog(current, feed);
    const loc = merged.locations.find((l) => l.key === 'JP-40-TOKYO-ULT')!;
    expect(loc.ips.map((i) => i.ip).sort()).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(merged.fetched).toBe(2000);
  });

  it('dedupes by ip instead of adding a duplicate', () => {
    const current = {
      fetched: 1000,
      locations: [
        {
          key: 'JP-40-TOKYO-ULT',
          country: 'JP',
          city: 'Tokyo',
          ips: [{ ip: '1.2.3.4', firstSeen: 1000, lastOk: 1500 }],
        },
      ],
    };
    const feed = {
      fetched: 2000,
      locations: [
        {
          key: 'JP-40-TOKYO-ULT',
          country: 'JP',
          city: 'Tokyo',
          ips: [{ ip: '1.2.3.4', firstSeen: 2000, lastOk: null }],
        },
      ],
    };

    const merged = mergeCatalog(current, feed);
    const loc = merged.locations.find((l) => l.key === 'JP-40-TOKYO-ULT')!;
    expect(loc.ips).toHaveLength(1);
    // the existing entry (with its lastOk history) is kept, not overwritten by the feed's stub
    expect(loc.ips[0]).toEqual({ ip: '1.2.3.4', firstSeen: 1000, lastOk: 1500 });
  });

  it('adds a brand-new location from the feed', () => {
    const current = { fetched: 1000, locations: [] };
    const feed = {
      fetched: 2000,
      locations: [
        {
          key: 'FR-2-PARIS',
          country: 'FR',
          city: 'Paris',
          ips: [{ ip: '9.9.9.9', firstSeen: 2000, lastOk: null }],
        },
      ],
    };
    const merged = mergeCatalog(current, feed);
    expect(merged.locations.map((l) => l.key)).toEqual(['FR-2-PARIS']);
  });
});
