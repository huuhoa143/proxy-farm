import { describe, expect, it } from 'vitest';
import { loadSeed, mergeCatalog } from './catalog';

describe('loadSeed', () => {
  it('reads the bundled hma-ovpn-seed.json and converts it to the catalog schema', async () => {
    const catalog = await loadSeed();
    expect(catalog.locations.length).toBe(115);
    const abuDhabi = catalog.locations.find((l) => l.key === 'AE-1-ABU-DHABI');
    expect(abuDhabi).toBeDefined();
    expect(abuDhabi!.country).toBe('AE');
    expect(abuDhabi!.city).toBe('Abu Dhabi');
    expect(abuDhabi!.ips).toEqual([{ ip: '5.62.19.134', firstSeen: catalog.fetched, lastOk: null }]);
  });

  it('every location has exactly one seed IP with lastOk null', async () => {
    const catalog = await loadSeed();
    for (const loc of catalog.locations) {
      expect(loc.ips).toHaveLength(1);
      expect(loc.ips[0].lastOk).toBeNull();
      expect(loc.ips[0].firstSeen).toBe(catalog.fetched);
    }
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
