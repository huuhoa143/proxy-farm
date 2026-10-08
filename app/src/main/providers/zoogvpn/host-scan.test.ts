import { describe, expect, it } from 'vitest';
import { cityOf, formatServersFile, mergeScan, parseZoogHost, seriesOf, sortServers, zoogHostName } from './host-scan';
import type { ZoogServer } from './servers';

const zs = (host: string, country: string, countryName: string, city = countryName, protos = { udp: 1194, tcp: 443 }): ZoogServer => ({
  host,
  country,
  countryName,
  city,
  protos,
});

describe('parseZoogHost / zoogHostName', () => {
  it('splits numbered hosts with and without a region and round-trips them', () => {
    expect(parseZoogHost('jp10.webunlim.com')).toEqual({ prefix: 'jp', n: 10, region: undefined, domain: 'webunlim.com' });
    expect(parseZoogHost('us4.east.zoogvpn.com')).toEqual({ prefix: 'us', n: 4, region: 'east', domain: 'zoogvpn.com' });
    for (const h of ['jp10.webunlim.com', 'us4.east.zoogvpn.com']) expect(zoogHostName(parseZoogHost(h)!)).toBe(h);
  });

  it('leaves off-scheme hosts alone', () => {
    expect(parseZoogHost('uk.zgfree.info')).toBeUndefined();
    expect(parseZoogHost('jp1.example.com')).toBeUndefined();
  });
});

describe('seriesOf', () => {
  it('learns one series per (country, prefix, region) with the highest listed number', () => {
    const series = seriesOf([
      zs('uk2.webunlim.com', 'GB', 'United Kingdom'),
      zs('uk3.zoogvpn.com', 'GB', 'United Kingdom'),
      zs('uk.zgfree.info', 'GB', 'United Kingdom'),
      zs('us1.east.webunlim.com', 'US', 'United States', 'East'),
    ]);
    expect(series).toEqual([
      { country: 'GB', countryName: 'United Kingdom', prefix: 'uk', region: undefined, knownMax: 3 },
      { country: 'US', countryName: 'United States', prefix: 'us', region: 'east', knownMax: 1 },
    ]);
  });
});

describe('cityOf', () => {
  const bundled = [zs('us.zgfree.info', 'US', 'United States'), zs('jp1.webunlim.com', 'JP', 'Japan', 'Japan')];

  it('a region label is the city, title-cased', () => {
    expect(cityOf('us9.west.webunlim.com', 'US', 'United States', bundled)).toBe('West');
  });

  it("otherwise the city the list uses for the country's region-less hosts", () => {
    expect(cityOf('jp7.webunlim.com', 'JP', 'Japan', [zs('jp1.webunlim.com', 'JP', 'Japan', 'Tokyo')])).toBe('Tokyo');
  });

  it('falls back to the country name', () => {
    expect(cityOf('sg2.webunlim.com', 'SG', 'Singapore', bundled)).toBe('Singapore');
  });
});

describe('mergeScan', () => {
  const bundled = [
    { ...zs('jp1.webunlim.com', 'JP', 'Japan'), key: 'JP-JP1' } as ZoogServer,
    zs('jp3.webunlim.com', 'JP', 'Japan'),
    zs('de2.zoogvpn.com', 'DE', 'Germany'),
    zs('de7.webunlim.com', 'DE', 'Germany'),
  ];
  const bundledIps = new Map([
    ['jp1.webunlim.com', ['192.0.2.1']],
    ['jp3.webunlim.com', ['192.0.2.3']],
    ['de2.zoogvpn.com', []],
    ['de7.webunlim.com', ['198.51.100.7']],
  ]);
  const found = [
    { host: 'jp1.webunlim.com', country: 'JP', countryName: 'Japan', ips: ['192.0.2.1'] },
    { host: 'jp2.webunlim.com', country: 'JP', countryName: 'Japan', ips: ['192.0.2.2'] },
    { host: 'jp3.zoogvpn.com', country: 'JP', countryName: 'Japan', ips: ['192.0.2.3'] },
    { host: 'fr4.webunlim.com', country: 'FR', countryName: 'France', ips: ['198.51.100.7'] },
  ];

  it('keeps resolving bundled hosts, adds new ones, drops vanished ones and same-IP twins', () => {
    const r = mergeScan(bundled, bundledIps, found);
    expect(r.servers.map((s) => s.host)).toEqual(['de7.webunlim.com', 'fr4.webunlim.com', 'jp1.webunlim.com', 'jp2.webunlim.com', 'jp3.webunlim.com']);
    expect(r.vanished).toEqual(['de2.zoogvpn.com']);
    expect(r.duplicates).toEqual([{ host: 'jp3.zoogvpn.com', sameAs: 'jp3.webunlim.com' }]);
    expect(r.crossLocation).toEqual([{ ip: '198.51.100.7', hosts: ['de7.webunlim.com', 'fr4.webunlim.com'] }]);
  });

  it('keeps bundled protos, gives new hosts UDP 1194 only, and drops the legacy per-host key', () => {
    const r = mergeScan(bundled, bundledIps, found);
    const jp1 = r.servers.find((s) => s.host === 'jp1.webunlim.com')!;
    expect(jp1).toEqual(zs('jp1.webunlim.com', 'JP', 'Japan'));
    expect(r.servers.find((s) => s.host === 'jp2.webunlim.com')!.protos).toEqual({ udp: 1194 });
  });

  it('never drops a bundled host for sharing an IP with another bundled host', () => {
    const twins = [zs('nl1.webunlim.com', 'NL', 'Netherlands'), zs('nl.zgfree.info', 'NL', 'Netherlands')];
    const ips = new Map([
      ['nl1.webunlim.com', ['192.0.2.9']],
      ['nl.zgfree.info', ['192.0.2.9']],
    ]);
    expect(mergeScan(twins, ips, []).servers).toHaveLength(2);
  });
});

describe('sortServers / formatServersFile', () => {
  it('orders by country, city, number, webunlim before zoogvpn, off-scheme hosts last', () => {
    const sorted = sortServers([
      zs('uk.zgfree.info', 'GB', 'United Kingdom'),
      zs('uk10.webunlim.com', 'GB', 'United Kingdom'),
      zs('uk2.zoogvpn.com', 'GB', 'United Kingdom'),
      zs('uk2.webunlim.com', 'GB', 'United Kingdom'),
      zs('ae1.webunlim.com', 'AE', 'United Arab Emirates'),
    ]);
    expect(sorted.map((s) => s.host)).toEqual(['ae1.webunlim.com', 'uk2.webunlim.com', 'uk2.zoogvpn.com', 'uk10.webunlim.com', 'uk.zgfree.info']);
  });

  it('writes valid JSON with one server per line', () => {
    const servers = [zs('jp1.webunlim.com', 'JP', 'Japan'), zs('jp2.webunlim.com', 'JP', 'Japan')];
    const text = formatServersFile(servers, '2026-10-08');
    expect(JSON.parse(text)).toEqual({ scanned: '2026-10-08', servers });
    expect(text.split('\n').filter((l) => l.includes('"host"'))).toHaveLength(2);
  });
});
