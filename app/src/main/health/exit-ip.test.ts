import { describe, expect, it } from 'vitest';
import { probeExitIp, buildSocksProxyUrl, isValidCountryCode, type FetchViaProxy } from './exit-ip';

/** Builds a fake transport keyed by URL substring, bypassing a real SOCKS5 hop — the
 * unit under test is the fallback/parse/cache logic, not the `socks` library itself. */
function fakeTransport(responses: Record<string, { body?: string; error?: string }>): FetchViaProxy {
  return async (url: string) => {
    const match = Object.entries(responses).find(([key]) => url.includes(key));
    if (!match) throw new Error(`fakeTransport: no stub for ${url}`);
    const [, resp] = match;
    if (resp.error) throw new Error(resp.error);
    return resp.body ?? '';
  };
}

describe('probeExitIp', () => {
  it('returns ip+country immediately when ifconfig.co answers first in the chain and ipify is skipped', async () => {
    // ipify answers (ip only), so the chain keeps going until a country shows up.
    const transport = fakeTransport({
      'api.ipify.org': { body: JSON.stringify({ ip: '5.62.19.134' }) },
      'ifconfig.co': { body: JSON.stringify({ ip: '5.62.19.134', country_iso: 'NL', country: 'Netherlands' }) },
      'ipinfo.io': { body: JSON.stringify({ ip: '5.62.19.134', country: 'NL' }) },
    });

    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() });
    expect(result).toEqual({ ip: '5.62.19.134', country: 'NL' });
  });

  it('falls back to ifconfig.co when api.ipify.org fails', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { error: 'ECONNREFUSED' },
      'ifconfig.co': { body: JSON.stringify({ ip: '203.0.113.9', country_iso: 'JP' }) },
    });
    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() });
    expect(result).toEqual({ ip: '203.0.113.9', country: 'JP' });
  });

  it('falls back to ipinfo.io when both api.ipify.org and ifconfig.co fail', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { error: 'ECONNREFUSED' },
      'ifconfig.co': { error: 'ETIMEDOUT' },
      'ipinfo.io': { body: JSON.stringify({ ip: '198.51.100.7', country: 'US' }) },
    });
    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() });
    expect(result).toEqual({ ip: '198.51.100.7', country: 'US' });
  });

  it('uses the geo cache when every endpoint yields ip but never a country', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { body: JSON.stringify({ ip: '5.62.19.134' }) },
      'ifconfig.co': { body: JSON.stringify({ ip: '5.62.19.134' }) }, // no country this time
      'ipinfo.io': { body: JSON.stringify({ ip: '5.62.19.134' }) },
    });
    const geoCache = new Map([['5.62.19.134', 'NL']]);
    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache });
    expect(result).toEqual({ ip: '5.62.19.134', country: 'NL' });
  });

  it('reports country "unknown" when nothing gave a country and nothing is cached', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { body: JSON.stringify({ ip: '5.62.19.134' }) },
      'ifconfig.co': { body: JSON.stringify({ ip: '5.62.19.134' }) },
      'ipinfo.io': { body: JSON.stringify({ ip: '5.62.19.134' }) },
    });
    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() });
    expect(result).toEqual({ ip: '5.62.19.134', country: 'unknown' });
  });

  it('caches a newly-learned country for that ip for subsequent calls', async () => {
    const geoCache = new Map<string, string>();
    const firstCall = fakeTransport({
      'api.ipify.org': { error: 'down' },
      'ifconfig.co': { body: JSON.stringify({ ip: '1.2.3.4', country_iso: 'DE' }) },
    });
    await probeExitIp(1234, { fetchViaProxy: firstCall, geoCache });
    expect(geoCache.get('1.2.3.4')).toBe('DE');

    const secondCall = fakeTransport({
      'api.ipify.org': { body: JSON.stringify({ ip: '1.2.3.4' }) },
      'ifconfig.co': { error: 'down again' },
      'ipinfo.io': { error: 'also down' },
    });
    const result = await probeExitIp(1234, { fetchViaProxy: secondCall, geoCache });
    expect(result).toEqual({ ip: '1.2.3.4', country: 'DE' });
  });

  it('throws when every endpoint fails outright (no ip at all)', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { error: 'down' },
      'ifconfig.co': { error: 'down' },
      'ipinfo.io': { error: 'down' },
    });
    await expect(probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() })).rejects.toThrow(/every IP-echo endpoint failed/);
  });

  it('checks the geo cache right after ipify returns the ip, short-circuiting the rest of the chain', async () => {
    let ifconfigCalled = false;
    let ipinfoCalled = false;
    const transport: FetchViaProxy = async (url) => {
      if (url.includes('api.ipify.org')) return JSON.stringify({ ip: '9.9.9.9' });
      if (url.includes('ifconfig.co')) {
        ifconfigCalled = true;
        return JSON.stringify({ ip: '9.9.9.9', country_iso: 'FR' });
      }
      if (url.includes('ipinfo.io')) {
        ipinfoCalled = true;
        return JSON.stringify({ ip: '9.9.9.9', country: 'FR' });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const geoCache = new Map([['9.9.9.9', 'DE']]); // pre-cached from an earlier probe

    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache });

    expect(result).toEqual({ ip: '9.9.9.9', country: 'DE' });
    expect(ifconfigCalled).toBe(false);
    expect(ipinfoCalled).toBe(false);
  });

  it('rejects a non-alpha2 country (e.g. a full name) and falls through to the next source', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { body: JSON.stringify({ ip: '1.1.1.1' }) },
      'ifconfig.co': { body: JSON.stringify({ ip: '1.1.1.1', country: 'Netherlands' }) }, // no country_iso, full name only
      'ipinfo.io': { body: JSON.stringify({ ip: '1.1.1.1', country: 'NL' }) },
    });
    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() });
    expect(result).toEqual({ ip: '1.1.1.1', country: 'NL' });
  });

  it('rejects a lower-case country code and falls through to the next source', async () => {
    const transport = fakeTransport({
      'api.ipify.org': { body: JSON.stringify({ ip: '1.1.1.1' }) },
      'ifconfig.co': { body: JSON.stringify({ ip: '1.1.1.1', country_iso: 'nl' }) },
      'ipinfo.io': { body: JSON.stringify({ ip: '1.1.1.1', country: 'NL' }) },
    });
    const result = await probeExitIp(1234, { fetchViaProxy: transport, geoCache: new Map() });
    expect(result).toEqual({ ip: '1.1.1.1', country: 'NL' });
  });
});

describe('isValidCountryCode', () => {
  it('accepts upper-case alpha-2', () => {
    expect(isValidCountryCode('NL')).toBe(true);
    expect(isValidCountryCode('US')).toBe(true);
  });

  it('rejects lower case, full names, 3-letter codes, and undefined', () => {
    expect(isValidCountryCode('nl')).toBe(false);
    expect(isValidCountryCode('Netherlands')).toBe(false);
    expect(isValidCountryCode('NLD')).toBe(false);
    expect(isValidCountryCode(undefined)).toBe(false);
  });
});

describe('buildSocksProxyUrl', () => {
  it('builds a plain socks5h url with no auth', () => {
    expect(buildSocksProxyUrl(1080)).toBe('socks5h://127.0.0.1:1080');
  });

  it('embeds username:password as userinfo when auth is given', () => {
    expect(buildSocksProxyUrl(1080, { username: 'alice', password: 'S3cr3t' })).toBe('socks5h://alice:S3cr3t@127.0.0.1:1080');
  });

  it('percent-encodes special characters in username/password', () => {
    expect(buildSocksProxyUrl(1080, { username: 'a@b', password: 'p@ss:word' })).toBe(
      'socks5h://a%40b:p%40ss%3Aword@127.0.0.1:1080',
    );
  });
});

describe('ipinfo 429-in-200 body', () => {
  it('falls through to another endpoint instead of returning empty', async () => {
    const bodies: Record<string, string> = {
      'https://ipinfo.io/json': JSON.stringify({ status: 429, error: { title: 'rate limited' } }),
      'https://ifconfig.co/json': JSON.stringify({ ip: '203.0.113.9', country_iso: 'JP' }),
      'https://api.ipify.org?format=json': JSON.stringify({ ip: '203.0.113.9' }),
    };
    const res = await probeExitIp(39999, { fetchViaProxy: async (url: string) => bodies[url] ?? '' });
    expect(res.ip).toBe('203.0.113.9');
    expect(res.country).toBe('JP');
  });
});
