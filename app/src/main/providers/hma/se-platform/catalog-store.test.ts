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
      ips: [{ ip: '1.1.1.1', protocol: 'openvpn', udp_ports: [1194], geo: { country_code: 'US', location_key: key, city: 'Honolulu' } }],
    },
  });
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'se-cat-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake API that records every call (url + whether it carried a token). */
function recordingNet() {
  const calls: Array<{ url: string; auth?: string }> = [];
  const net: SeFetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.includes('/discovery/v12/geos')) return jsonRes(200, GEOS);
    if (url.includes('/discovery/v9/discover')) return discoverRes(new URL(url).searchParams.get('location_key')!);
    throw new Error(`unexpected ${url}`);
  };
  return { net, calls };
}

describe('createSeCatalogStore', () => {
  const minter = { getToken: vi.fn(async () => fakeJwt(9e9)), invalidate: vi.fn(), refreshToken: () => undefined };
  const ctx = { minter, tenant: 'tenant' };

  it('loads geos without a token, caches them, and never discovers on its own', async () => {
    await withTmp(async (dir) => {
      const { net, calls } = recordingNet();
      const store = createSeCatalogStore({ geosPath: path.join(dir, 'g.json'), catalogPath: path.join(dir, 'c.json'), net });
      const geos = await store.geos({ tenant: 'tenant' });
      expect(geos.map((g) => g.locationKey)).toEqual(['US']);
      await store.geos({ tenant: 'tenant' }); // cached
      expect(calls).toHaveLength(1);
      expect(calls[0].auth).toBeUndefined();
      expect(calls.some((c) => c.url.includes('/v9/discover'))).toBe(false); // no sweep
      expect(store.snapshot().locations).toHaveLength(0);
    });
  });

  it('force re-fetches the geos list', async () => {
    await withTmp(async (dir) => {
      const { net, calls } = recordingNet();
      const store = createSeCatalogStore({ geosPath: path.join(dir, 'g.json'), catalogPath: path.join(dir, 'c.json'), net });
      await store.geos({ tenant: 'tenant' });
      await store.geos({ tenant: 'tenant' }, { force: true });
      expect(calls.filter((c) => c.url.includes('/geos'))).toHaveLength(2);
    });
  });

  it('refreshOne discovers exactly that location and merges its IPs', async () => {
    await withTmp(async (dir) => {
      const { net, calls } = recordingNet();
      const onChange = vi.fn();
      const store = createSeCatalogStore({ geosPath: path.join(dir, 'g.json'), catalogPath: path.join(dir, 'c.json'), net, onChange });
      await store.refreshOne(ctx, 'US-HI-HONOLULU');
      const discovers = calls.filter((c) => c.url.includes('/v9/discover'));
      expect(discovers).toHaveLength(1);
      expect(discovers[0].url).toContain('location_key=US-HI-HONOLULU');
      expect(discovers[0].auth).toMatch(/^Bearer /);
      expect(store.snapshot().locations.map((l) => l.key)).toEqual(['US-HI-HONOLULU']);
      expect(onChange).toHaveBeenCalled();
    });
  });
});
