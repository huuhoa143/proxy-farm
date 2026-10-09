import { describe, expect, it } from 'vitest';
import type { PortRow, PortState } from '../shared/contracts';
import { createCheckStore } from './checkStore';

function row(key: string, state: PortState): PortRow {
  return { key, locationKey: key.split('#')[0], providerId: 'hma', accountId: 'a', label: '', country: 'JP', city: 'Tokyo', proxyPort: 1, enabled: true, state, autoRotateMin: 0 };
}
const online = (since: number): PortState => ({ kind: 'online', since, exitIp: '1.1.1.1', country: 'JP' });

function deferred() {
  let resolve!: (v: { ok: boolean; latencyMs?: number }) => void;
  const promise = new Promise<{ ok: boolean; latencyMs?: number }>((r) => (resolve = r));
  return { promise, resolve };
}

describe('check store', () => {
  it('checks online ports in the given order and summarises', async () => {
    const store = createCheckStore();
    const order: string[] = [];
    const rows = [row('b#1', online(1)), row('a#1', online(1)), row('c#1', { kind: 'stopped' })];
    await store.run({ testPort: async (key) => (order.push(key), key === 'a#1' ? { ok: false } : { ok: true, latencyMs: 9 }) }, rows);
    expect(order).toEqual(['b#1', 'a#1']);
    expect(store.getState().summary).toEqual({ alive: 1, dead: 1, skipped: 1, deadKeys: ['a#1'] });
    expect(store.getState().checks['b#1']).toMatchObject({ ok: true, latencyMs: 9, since: 1 });
    expect(store.getState().progress).toBeNull();
  });

  it('notifies subscribers, refuses a second run, and Stop skips the queued checks', async () => {
    const store = createCheckStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));
    const pending: Array<ReturnType<typeof deferred>> = [];
    const testPort = () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    };
    const rows = Array.from({ length: 6 }, (_, i) => row(`p#${i + 1}`, online(1)));
    const first = store.run({ testPort }, rows);
    expect(store.getState().progress).toEqual({ done: 0, total: 6 });
    await store.run({ testPort }, rows); // ignored while running
    expect(pending).toHaveLength(4);
    store.stop();
    for (const d of pending) d.resolve({ ok: true });
    await first;
    expect(store.getState().summary).toMatchObject({ alive: 4, skipped: 2 });
    expect(notified).toBeGreaterThan(0);
  });

  it('prune drops results of ports that reconnected or are gone', async () => {
    const store = createCheckStore();
    await store.run({ testPort: async () => ({ ok: true }) }, [row('a#1', online(1)), row('b#1', online(1))]);
    store.prune([row('a#1', online(2))]);
    expect(store.getState().checks).toEqual({});
  });

  it('re-reads each port when its turn comes: gone offline or removed counts as skipped', async () => {
    const store = createCheckStore();
    const rows = [row('a#1', online(1)), row('b#1', online(1)), row('c#1', online(1))];
    store.prune(rows);
    const probed: string[] = [];
    // Before the run starts, b goes offline and c is removed.
    store.prune([row('a#1', online(1)), row('b#1', { kind: 'stopped' })]);
    await store.run({ testPort: async (key) => (probed.push(key), { ok: false }) }, rows);
    expect(probed).toEqual(['a#1']);
    expect(store.getState().summary).toEqual({ alive: 0, dead: 1, skipped: 2, deadKeys: ['a#1'] });
  });

  it('drops a result whose port reconnected during the probe, and does not count it', async () => {
    const store = createCheckStore();
    const rows = [row('a#1', online(1)), row('b#1', online(1))];
    store.prune(rows);
    const run = store.run(
      {
        testPort: async (key) => {
          if (key === 'a#1') store.prune([row('a#1', online(2)), row('b#1', online(1))]);
          return { ok: false };
        },
      },
      rows,
    );
    await run;
    expect(Object.keys(store.getState().checks)).toEqual(['b#1']);
    expect(store.getState().summary).toEqual({ alive: 0, dead: 1, skipped: 1, deadKeys: ['b#1'] });
    expect(store.getState().progress).toBeNull();
  });
});
