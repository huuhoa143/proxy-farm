import { describe, expect, it } from 'vitest';
import type { PortRow, ProviderId, Target } from '../../shared/contracts';
import { resolveRotateKey } from '../webhook/index';
import { reattachPorts, reattachWithAliases } from './reattach';

function row(key: string, extra: Partial<PortRow> = {}): PortRow {
  return {
    key,
    locationKey: key.split('#')[0],
    providerId: 'zoogvpn',
    accountId: 'z1',
    label: 'old',
    country: 'JP',
    city: 'Japan',
    proxyPort: 29001,
    enabled: true,
    state: { kind: 'queued' },
    autoRotateMin: 10,
    ...extra,
  };
}

function target(key: string, country: string, city: string, servers: string[]): Target {
  return { key, providerId: key.split(':')[0] as ProviderId, country, city, label: `${city} (${country})`, servers };
}

const zoog = new Map<ProviderId, Target[]>([
  [
    'zoogvpn',
    [
      target('zoogvpn:JP', 'JP', 'Tokyo', ['jp2.webunlim.com', 'jp3.webunlim.com']),
      target('zoogvpn:US-EAST', 'US', 'East', ['us5.east.webunlim.com']),
      target('zoogvpn:US-WEST', 'US', 'West', ['us2.west.webunlim.com']),
      target('zoogvpn:DE', 'DE', 'Frankfurt', ['de1.webunlim.com']),
    ],
  ],
]);

describe('reattachPorts (spec §6.8 boot-time re-attach)', () => {
  it('moves a row of a retired location to the target whose pool holds its pinned server', () => {
    const [out] = reattachPorts([row('zoogvpn:JP-JP3#1', { server: 'jp3.webunlim.com', serverIp: '1.2.3.4' })], zoog);
    expect(out).toMatchObject({
      key: 'zoogvpn:JP#1',
      locationKey: 'zoogvpn:JP',
      server: 'jp3.webunlim.com',
      serverIp: '1.2.3.4',
      city: 'Tokyo',
      label: 'Tokyo (JP)',
      autoRotateMin: 10,
      proxyPort: 29001,
      accountId: 'z1',
      enabled: true,
    });
  });

  it('a row that never ran is matched by the host named in its old key', () => {
    const [out] = reattachPorts([row('zoogvpn:JP-JP2#1')], zoog);
    expect(out).toMatchObject({ key: 'zoogvpn:JP#1', server: 'jp2.webunlim.com' });
  });

  it('two old one-host locations landing in one new location get #1 and #2', () => {
    const out = reattachPorts([row('zoogvpn:JP-JP2#1', { server: 'jp2.webunlim.com' }), row('zoogvpn:JP-JP3#1', { server: 'jp3.webunlim.com', proxyPort: 29002 })], zoog);
    expect(out.map((p) => p.key)).toEqual(['zoogvpn:JP#1', 'zoogvpn:JP#2']);
  });

  it('n skips numbers already used by rows of the new location', () => {
    const out = reattachPorts([row('zoogvpn:JP#1', { locationKey: 'zoogvpn:JP' }), row('zoogvpn:JP-JP3#1', { server: 'jp3.webunlim.com' })], zoog);
    expect(out[1].key).toBe('zoogvpn:JP#2');
  });

  it('a server gone from every pool falls back to country + region, unpinned', () => {
    const [out] = reattachPorts([row('zoogvpn:US-US1-EAST#1', { server: 'us1.east.webunlim.com', serverIp: '9.9.9.9', country: 'US' })], zoog);
    expect(out).toMatchObject({ key: 'zoogvpn:US-EAST#1', locationKey: 'zoogvpn:US-EAST' });
    expect(out.server).toBeUndefined();
    expect(out.serverIp).toBeUndefined();
  });

  it('falls back to the country-wide target when the country alone decides', () => {
    const [out] = reattachPorts([row('zoogvpn:DE-DE2#1', { server: 'de2.zoogvpn.com', country: 'DE' })], zoog);
    expect(out).toMatchObject({ key: 'zoogvpn:DE#1' });
    expect(out.server).toBeUndefined();
  });

  it('leaves an ambiguous or unmatched row alone (it fails with no-server)', () => {
    const ambiguous = row('zoogvpn:US-US9#1', { server: 'us9.gone.example', country: 'US' }); // US, no region, no country-wide target
    const unknown = row('zoogvpn:XX-XX1#1');
    expect(reattachPorts([ambiguous, unknown], zoog)).toEqual([ambiguous, unknown]);
  });

  it('leaves rows of current locations and of providers without targets untouched', () => {
    const current = row('zoogvpn:JP#1', { locationKey: 'zoogvpn:JP', server: 'jp2.webunlim.com' });
    const hma = row('hma:VN-51-HANOI#1', { providerId: 'hma', server: '1.1.1.1' });
    expect(reattachPorts([current, hma], zoog)).toEqual([current, hma]);
  });
});

describe('reattachWithAliases (webhook old keys, spec §6.6)', () => {
  it('records old location → new location for each moved location, merged into the existing map', () => {
    const { ports, aliases } = reattachWithAliases(
      [row('zoogvpn:JP-JP3#1', { server: 'jp3.webunlim.com' }), row('zoogvpn:JP#1', { locationKey: 'zoogvpn:JP' })],
      zoog,
      { 'zoogvpn:OLD': 'zoogvpn:DE' },
    );
    expect(ports.map((p) => p.key)).toEqual(['zoogvpn:JP#2', 'zoogvpn:JP#1']);
    expect(aliases).toEqual({ 'zoogvpn:OLD': 'zoogvpn:DE', 'zoogvpn:JP-JP3': 'zoogvpn:JP' });
  });

  it("an old location split across targets is aliased to where its lowest port went", () => {
    const { aliases } = reattachWithAliases(
      [row('zoogvpn:US-OLD#2', { server: 'us2.west.webunlim.com' }), row('zoogvpn:US-OLD#1', { server: 'us5.east.webunlim.com' })],
      zoog,
      {},
    );
    expect(aliases).toEqual({ 'zoogvpn:US-OLD': 'zoogvpn:US-EAST' });
  });

  it('after a reattach, the webhook resolves a bare old ZoogVPN key to the moved port', () => {
    const { ports, aliases } = reattachWithAliases([row('zoogvpn:JP-JP3#1', { server: 'jp3.webunlim.com' })], zoog, {});
    expect(resolveRotateKey('zoogvpn:JP-JP3', ports, aliases)).toBe('zoogvpn:JP#1');
  });
});
