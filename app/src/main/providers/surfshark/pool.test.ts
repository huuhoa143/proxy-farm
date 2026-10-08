import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSurfsharkPools, POOL_FORGET_MS, POOL_REFRESH_MS, POOL_RETRY_MS, type PoolNet } from './pool';

const HOST = 'jp-tok.prod.surfshark.com';

/**
 * Scripted resolvers: each call returns the next answer of its list (the last
 * one repeats); an `Error` entry rejects. Documentation-range IPs only.
 */
function fakeNet(system: Array<string[] | Error>, doh: Array<string[] | Error>) {
  const calls = { system: 0, doh: 0, sleeps: [] as number[] };
  const next = (list: Array<string[] | Error>, i: number) => {
    const v = list[Math.min(i, list.length - 1)];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  const net: PoolNet = {
    resolveSystem: () => next(system, calls.system++),
    resolveDoh: () => next(doh, calls.doh++),
    sleep: async (ms) => void calls.sleeps.push(ms),
  };
  return { net, calls };
}

let dir: string;
let poolPath: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pf-surfshark-pool-'));
  poolPath = path.join(dir, 'cache', 'surfshark-pools.json');
  clock = 1_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('surfshark pools: discovery', () => {
  it('unions A records from both resolvers across rounds and persists them per cluster', async () => {
    const { net, calls } = fakeNet(
      [['192.0.2.1', '192.0.2.2'], ['192.0.2.3', '192.0.2.1'], ['192.0.2.4', '192.0.2.5']],
      [['198.51.100.1', '192.0.2.2'], ['198.51.100.2', '198.51.100.3']],
    );
    const pools = createSurfsharkPools({ poolPath, net, now, rounds: 3, gapMs: 1500 });
    await pools.ensure([HOST]);
    await pools.idle();

    expect(new Set(pools.servers(HOST))).toEqual(
      new Set(['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5', '198.51.100.1', '198.51.100.2', '198.51.100.3']),
    );
    expect(calls.system).toBe(3);
    expect(calls.doh).toBe(3);
    expect(calls.sleeps).toEqual([1500, 1500]); // between rounds, not before the first

    const onDisk = JSON.parse(readFileSync(poolPath, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.clusters[HOST].sampledAt).toBe(clock);
    expect(onDisk.clusters[HOST].ips).toHaveLength(8);
  });

  it('returns after the first round for a cluster with no IPs; later rounds land in the background', async () => {
    const { net } = fakeNet([['192.0.2.1'], ['192.0.2.2']], [new Error('doh down')]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pools = createSurfsharkPools({ poolPath, net: { ...net, sleep: () => gate }, now, rounds: 2 });

    await pools.ensure([HOST]);
    expect(pools.servers(HOST)).toEqual(['192.0.2.1']); // one resolver failing is fine

    release();
    await pools.idle();
    expect(pools.servers(HOST)).toEqual(['192.0.2.1', '192.0.2.2']);
  });

  it('ignores non-IPv4 answers', async () => {
    const { net } = fakeNet([['192.0.2.1', '2001:db8::1', 'not-an-ip']], [['999.1.1.1']]);
    const pools = createSurfsharkPools({ poolPath, net, now, rounds: 1 });
    await pools.ensure([HOST]);
    await pools.idle();
    expect(pools.servers(HOST)).toEqual(['192.0.2.1']);
  });

  it('does not wait past its budget for first rounds on a black-holed network', async () => {
    const never = () => new Promise<string[]>(() => {});
    const pools = createSurfsharkPools({
      poolPath,
      net: { resolveSystem: never, resolveDoh: never, sleep: async () => {} },
      now,
      firstRoundBudgetMs: 30,
    });
    const started = Date.now();
    await pools.ensure([HOST]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pools.servers(HOST)).toEqual([]);
  });
});

describe('surfshark pools: schedule', () => {
  it('samples a cluster at most every 12 h, accumulating across refreshes', async () => {
    const { net, calls } = fakeNet([['192.0.2.1'], ['192.0.2.9']], [['192.0.2.1'], ['192.0.2.9']]);
    const pools = createSurfsharkPools({ poolPath, net, now, rounds: 1 });
    await pools.ensure([HOST]);
    await pools.idle();

    clock += POOL_REFRESH_MS - 1;
    await pools.ensure([HOST]);
    await pools.idle();
    expect(calls.system).toBe(1);

    clock += 1;
    await pools.ensure([HOST]);
    await pools.idle();
    expect(calls.system).toBe(2);
    expect(pools.servers(HOST)).toEqual(['192.0.2.1', '192.0.2.9']);
  });

  it('a pool loaded from disk is not re-sampled before it is due', async () => {
    const first = fakeNet([['192.0.2.1']], [['192.0.2.2']]);
    const a = createSurfsharkPools({ poolPath, net: first.net, now, rounds: 1 });
    await a.ensure([HOST]);
    await a.idle();

    const second = fakeNet([['192.0.2.7']], [['192.0.2.7']]);
    const b = createSurfsharkPools({ poolPath, net: second.net, now, rounds: 1 }); // e.g. after an app restart
    await b.ensure([HOST]);
    await b.idle();
    expect(second.calls.system).toBe(0);
    expect(new Set(b.servers(HOST))).toEqual(new Set(['192.0.2.1', '192.0.2.2']));
  });

  it('retries a failed discovery after 15 min, not on every call', async () => {
    const offline = new Error('offline');
    const { net, calls } = fakeNet([offline, offline, ['192.0.2.1']], [offline, offline, ['192.0.2.1']]);
    const pools = createSurfsharkPools({ poolPath, net, now, rounds: 1 });
    await pools.ensure([HOST]); // first round fails …
    await pools.idle(); // … and so does the background run
    expect(pools.servers(HOST)).toEqual([]);
    const after = calls.system;

    clock += POOL_RETRY_MS - 1;
    await pools.ensure([HOST]);
    expect(calls.system).toBe(after);

    clock += 1;
    await pools.ensure([HOST]);
    await pools.idle();
    expect(pools.servers(HOST)).toEqual(['192.0.2.1']);
  });

  it('drops an IP not seen for 7 days, but only after a successful sample', async () => {
    const answers: Array<string[] | Error> = [['192.0.2.1', '192.0.2.2']];
    const net: PoolNet = {
      resolveSystem: async () => {
        const a = answers[0];
        if (a instanceof Error) throw a;
        return a;
      },
      resolveDoh: async () => {
        throw new Error('doh down');
      },
      sleep: async () => {},
    };
    const pools = createSurfsharkPools({ poolPath, net, now, rounds: 1 });
    await pools.ensure([HOST]);
    await pools.idle();

    // A week offline: the refresh fails, nothing is pruned.
    clock += POOL_FORGET_MS + 1;
    answers[0] = new Error('offline');
    await pools.ensure([HOST]);
    await pools.idle();
    expect(pools.servers(HOST)).toEqual(['192.0.2.1', '192.0.2.2']);

    // Back online: .2 is still in DNS, .1 is gone and is dropped.
    clock += POOL_RETRY_MS;
    answers[0] = ['192.0.2.2'];
    await pools.ensure([HOST]);
    await pools.idle();
    expect(pools.servers(HOST)).toEqual(['192.0.2.2']);
  });
});

describe('surfshark pools: order and persistence', () => {
  it('lists IPs seen in the last day first, then oldest known first', () => {
    const day = 24 * 60 * 60 * 1000;
    writeFileSync(
      path.join(dir, 'pools.json'),
      JSON.stringify({
        version: 1,
        clusters: {
          [HOST]: {
            sampledAt: clock,
            ips: [
              { ip: '192.0.2.30', firstSeen: clock - 1000, lastSeen: clock },
              { ip: '192.0.2.10', firstSeen: clock - 9 * day, lastSeen: clock - 3 * day }, // stale
              { ip: '192.0.2.20', firstSeen: clock - 5 * day, lastSeen: clock },
            ],
          },
        },
      }),
    );
    const { net } = fakeNet([[]], [[]]);
    const pools = createSurfsharkPools({ poolPath: path.join(dir, 'pools.json'), net, now });
    return pools.ensure([HOST]).then(() => {
      expect(pools.servers(HOST)).toEqual(['192.0.2.20', '192.0.2.30', '192.0.2.10']);
    });
  });

  it('starts empty from a corrupt pool file', async () => {
    writeFileSync(path.join(dir, 'pools.json'), '{not json');
    const { net } = fakeNet([['192.0.2.1']], [['192.0.2.1']]);
    const pools = createSurfsharkPools({ poolPath: path.join(dir, 'pools.json'), net, now, rounds: 1 });
    await pools.ensure([HOST]);
    await pools.idle();
    expect(pools.servers(HOST)).toEqual(['192.0.2.1']);
  });
});
