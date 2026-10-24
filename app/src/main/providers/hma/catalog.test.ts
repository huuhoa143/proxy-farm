import { describe, expect, it } from 'vitest';
import { mergeCatalog } from './catalog';

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
    // the existing entry keeps its firstSeen/lastOk history; only its freshness (lastSeen)
    // advances to the feed's time, so it is not overwritten by the feed's stub.
    expect(loc.ips[0]).toEqual({ ip: '1.2.3.4', firstSeen: 1000, lastOk: 1500, lastSeen: 2000 });
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

  const loc = (key: string, ips: Array<{ ip: string; firstSeen: number; lastOk: number | null; lastSeen?: number }>) => ({
    key,
    country: key.slice(0, 2),
    city: key,
    ips,
  });

  it('with staleSec, drops an unseen IP a touched location has not returned in a while', () => {
    const current = {
      fetched: 1000,
      locations: [loc('US-WA-SEATTLE-ULT', [
        { ip: 'fresh', firstSeen: 100, lastOk: null, lastSeen: 100 },
        { ip: 'stale', firstSeen: 100, lastOk: null, lastSeen: 100 },
      ])],
    };
    // A later discover of Seattle returns only `fresh`; `stale` (last seen at 100, well past
    // the 500 s window before 5000) is dropped.
    const feed = { fetched: 5000, locations: [loc('US-WA-SEATTLE-ULT', [{ ip: 'fresh', firstSeen: 5000, lastOk: null, lastSeen: 5000 }])] };
    const merged = mergeCatalog(current, feed, { staleSec: 500 });
    expect(merged.locations[0].ips.map((i) => i.ip)).toEqual(['fresh']);
  });

  it('never evicts a protected (held) IP, however stale', () => {
    const current = {
      fetched: 1000,
      locations: [loc('US-WA-SEATTLE-ULT', [
        { ip: 'fresh', firstSeen: 100, lastOk: null, lastSeen: 100 },
        { ip: 'held', firstSeen: 100, lastOk: null, lastSeen: 100 },
      ])],
    };
    const feed = { fetched: 5000, locations: [loc('US-WA-SEATTLE-ULT', [{ ip: 'fresh', firstSeen: 5000, lastOk: null, lastSeen: 5000 }])] };
    const merged = mergeCatalog(current, feed, { staleSec: 500, protect: new Set(['held']) });
    expect(merged.locations[0].ips.map((i) => i.ip).sort()).toEqual(['fresh', 'held']);
  });

  it('with staleSec, leaves untouched locations (not in the feed) alone', () => {
    const current = {
      fetched: 1000,
      locations: [loc('JP-40-TOKYO-ULT', [{ ip: 'old', firstSeen: 100, lastOk: null, lastSeen: 100 }])],
    };
    const feed = { fetched: 5000, locations: [loc('US-WA-SEATTLE-ULT', [{ ip: 'new', firstSeen: 5000, lastOk: null, lastSeen: 5000 }])] };
    const merged = mergeCatalog(current, feed, { staleSec: 500 });
    const tokyo = merged.locations.find((l) => l.key === 'JP-40-TOKYO-ULT')!;
    expect(tokyo.ips.map((i) => i.ip)).toEqual(['old']); // not pruned: the feed never covered Tokyo
  });
});
