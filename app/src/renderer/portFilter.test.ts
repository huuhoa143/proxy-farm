import { beforeEach, describe, expect, it } from 'vitest';
import type { PortRow, PortState } from '../shared/contracts';
import {
  bucketCounts,
  currentCheck,
  exportChecks,
  filterPorts,
  loadFilter,
  matchesQuery,
  NO_FILTER,
  saveFilter,
  type CheckRecord,
} from './portFilter';

function row(key: string, state: PortState, over: Partial<PortRow> = {}): PortRow {
  return {
    key,
    locationKey: key.split('#')[0],
    providerId: 'hma',
    accountId: 'hma-1',
    label: 'Tokyo',
    country: 'JP',
    city: 'Tokyo',
    proxyPort: 29001,
    enabled: true,
    state,
    autoRotateMin: 0,
    ...over,
  };
}

const online = (since: number, exitIp = '203.0.113.10'): PortState => ({ kind: 'online', since, exitIp, country: 'JP', latencyMs: 40 });

const rows: PortRow[] = [
  row('hma:JP#1', online(100)),
  row('hma:JP#2', online(100, '203.0.113.11'), { proxyPort: 29002 }),
  row('hma:VN#1', { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'x' }, { country: 'VN', city: 'Hanoi', label: 'Hà Nội', proxyPort: 29003 }),
  row('zoogvpn:DE#1', { kind: 'connecting', since: 5 }, { providerId: 'zoogvpn', country: 'DE', city: 'Frankfurt', proxyPort: 29004, serverIp: '198.51.100.7' }),
  row('surfshark:NL#1', { kind: 'stopped' }, { providerId: 'surfshark', country: 'NL', city: 'Amsterdam', proxyPort: 29005 }),
];

describe('check results', () => {
  it('apply only to the connection they were taken on', () => {
    const checks: Record<string, CheckRecord> = { 'hma:JP#1': { ok: false, at: 200, since: 100 } };
    expect(currentCheck(rows[0], checks)).toBeDefined();
    // The port reconnected (new `since`): the old result no longer says anything.
    expect(currentCheck(row('hma:JP#1', online(300)), checks)).toBeUndefined();
    expect(currentCheck(row('hma:JP#1', { kind: 'stopped' }), checks)).toBeUndefined();
  });
});

describe('bucketCounts', () => {
  it('puts each port in exactly one bucket, so they add up to All', () => {
    const checks: Record<string, CheckRecord> = { 'hma:JP#2': { ok: false, at: 200, since: 100 } };
    const counts = bucketCounts(rows, checks);
    expect(counts).toEqual({ all: 5, alive: 1, dead: 2, connecting: 1, stopped: 1 });
    expect(counts.alive + counts.dead + counts.connecting + counts.stopped).toBe(counts.all);
  });
});

describe('matchesQuery', () => {
  it('matches the location in either language, accent-insensitively', () => {
    expect(matchesQuery(rows[2], 'ha noi')).toBe(true);
    expect(matchesQuery(rows[0], 'nhật')).toBe(true); // Nhật Bản (vi)
    expect(matchesQuery(rows[0], 'japan')).toBe(true);
    expect(matchesQuery(rows[4], 'Hà Lan')).toBe(true); // Netherlands (vi)
    expect(matchesQuery(rows[0], 'amsterdam')).toBe(false);
  });

  it('matches the exit IP, server IP and local port', () => {
    expect(matchesQuery(rows[1], '113.11')).toBe(true);
    expect(matchesQuery(rows[3], '198.51.100.7')).toBe(true);
    expect(matchesQuery(rows[3], '29004')).toBe(true);
    expect(matchesQuery(rows[3], '29001')).toBe(false);
  });

  it('an empty or blank query matches everything', () => {
    expect(matchesQuery(rows[0], '  ')).toBe(true);
  });
});

describe('filterPorts', () => {
  it('combines status, provider and search', () => {
    const keys = (f: Parameters<typeof filterPorts>[1]) => filterPorts(rows, f, {}).map((r) => r.key);
    expect(keys(NO_FILTER)).toHaveLength(5);
    expect(keys({ ...NO_FILTER, status: 'alive' })).toEqual(['hma:JP#1', 'hma:JP#2']);
    expect(keys({ ...NO_FILTER, status: 'dead' })).toEqual(['hma:VN#1']);
    expect(keys({ ...NO_FILTER, provider: 'hma', query: 'tokyo' })).toEqual(['hma:JP#1', 'hma:JP#2']);
    expect(keys({ status: 'alive', provider: 'zoogvpn', query: '' })).toEqual([]);
  });
});

describe('exportChecks', () => {
  it('hands export only the still-current results, without renderer bookkeeping', () => {
    const checks: Record<string, CheckRecord> = {
      'hma:JP#1': { ok: true, latencyMs: 33, at: 200, since: 100 },
      'hma:JP#2': { ok: false, at: 200, since: 99 },
    };
    expect(exportChecks(rows, checks)).toEqual({ 'hma:JP#1': { ok: true, latencyMs: 33 } });
  });
});

describe('persisted filter', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips through localStorage', () => {
    saveFilter({ status: 'dead', provider: 'nordvpn', query: 'tokyo' });
    expect(loadFilter()).toEqual({ status: 'dead', provider: 'nordvpn', query: 'tokyo' });
  });

  it('falls back to no filter for missing or garbled values', () => {
    expect(loadFilter()).toEqual(NO_FILTER);
    window.localStorage.setItem('proxyfarm.portFilter', '{"status":"weird","provider":"acme","query":7}');
    expect(loadFilter()).toEqual(NO_FILTER);
    window.localStorage.setItem('proxyfarm.portFilter', 'not json');
    expect(loadFilter()).toEqual(NO_FILTER);
  });
});
