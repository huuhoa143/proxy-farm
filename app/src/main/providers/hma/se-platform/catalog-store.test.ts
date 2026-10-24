import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSeCatalogStore } from './catalog-store';
import type { SeFetch, SeResponse } from './types';

function jsonRes(status: number, body: unknown): SeResponse {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
function fakeJwt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSec })}.sig`;
}

const GEOS = {
  status: { code: 0 },
  data: {
    geos: [
      { location_key: 'US', country_code: 'US', country: 'United States', state: 'active', cities: [{ location_key: 'US-HI-HONOLULU', location_city: 'Honolulu', state: 'active' }] },
    ],
  },
};
function discoverRes(key: string) {
  return jsonRes(200, {
    status: { code: 0 },
    data: {
      current_time: 1000,
      expires_at: 1120,
      ips: [{ ip: key === 'US' ? '1.1.1.1' : '2.2.2.2', protocol: 'openvpn', udp_ports: [1194], geo: { country_code: 'US', location_key: `${key}-CITY`, city: 'C' } }],
    },
  });
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'se-cat-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createSeCatalogStore', () => {
  const minter = { getToken: vi.fn(async () => fakeJwt(9e9)) };
  const ctx = { minter, tenant: 'tenant' };

  it('snapshot starts empty; kickRefresh discovers + merges, onChange fires', async () => {
    await withTmp(async (dir) => {
      const net: SeFetch = async (url) => {
        if (url.includes('/discovery/v12/geos')) return jsonRes(200, GEOS);
        if (url.includes('/discovery/v9/discover')) return discoverRes(new URL(url).searchParams.get('location_key')!);
        throw new Error(`unexpected ${url}`);
      };
      const onChange = vi.fn();
      const store = createSeCatalogStore({
        geosPath: path.join(dir, 'geos.json'),
        catalogPath: path.join(dir, 'cat.json'),
        net,
        onChange,
      });
      expect(store.snapshot().locations).toHaveLength(0);
      await store.kickRefresh(ctx);
      expect(store.snapshot().locations.length).toBeGreaterThan(0);
      const keys = store.snapshot().locations.map((l) => l.key).sort();
      expect(keys).toContain('US-CITY'); // from discover(US)
      expect(onChange).toHaveBeenCalled();
    });
  });

  it('self-throttles: a second kickRefresh within the gap does not run', async () => {
    await withTmp(async (dir) => {
      let discovers = 0;
      const net: SeFetch = async (url) => {
        if (url.includes('/discovery/v12/geos')) return jsonRes(200, GEOS);
        if (url.includes('/discovery/v9/discover')) {
          discovers++;
          return discoverRes('US');
        }
        throw new Error(`unexpected ${url}`);
      };
      const store = createSeCatalogStore({ geosPath: path.join(dir, 'g.json'), catalogPath: path.join(dir, 'c.json'), net });
      await store.kickRefresh(ctx);
      expect(store.snapshot().locations.length).toBeGreaterThan(0);
      const after = discovers;
      store.kickRefresh(ctx); // within REFRESH_MIN_GAP_MS → ignored
      expect(discovers).toBe(after);
    });
  });
});
