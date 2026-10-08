import { describe, expect, it } from 'vitest';
import { createServerHealth, DEAD_TTL_MS, REFUSED_TTL_MS } from './server-health';

describe('server health (spec §6.8, per account and server)', () => {
  function clock(start = 1_000_000) {
    const t = { now: start };
    return { now: () => t.now, advance: (ms: number) => (t.now += ms) };
  }

  it('an unknown pair is usable and has no lastOk', () => {
    const h = createServerHealth();
    expect(h.isUsable('a', '1.1.1.1')).toBe(true);
    expect(h.lastOk('a', '1.1.1.1')).toBeUndefined();
  });

  it('dead holds for 2 h, refused for 7 days, then both clear', () => {
    const c = clock();
    const h = createServerHealth({ now: c.now });
    h.markDead('a', 'D');
    h.markRefused('a', 'R');
    expect(h.isUsable('a', 'D')).toBe(false);
    expect(h.isUsable('a', 'R')).toBe(false);
    c.advance(DEAD_TTL_MS);
    expect(h.isDead('a', 'D')).toBe(false);
    expect(h.isRefused('a', 'R')).toBe(true);
    c.advance(REFUSED_TTL_MS - DEAD_TTL_MS);
    expect(h.isRefused('a', 'R')).toBe(false);
  });

  it('marks are per account: a server refused for one account stays usable for another', () => {
    const h = createServerHealth();
    h.markRefused('a', 'S');
    h.markDead('a', 'T');
    expect(h.isUsable('a', 'S')).toBe(false);
    expect(h.isUsable('b', 'S')).toBe(true);
    expect(h.isUsable('b', 'T')).toBe(true);
  });

  it('markOk records lastOk and clears refused and dead for that pair', () => {
    const c = clock();
    const h = createServerHealth({ now: c.now });
    h.markRefused('a', 'S');
    h.markDead('a', 'S');
    h.markOk('a', 'S');
    expect(h.isUsable('a', 'S')).toBe(true);
    expect(h.lastOk('a', 'S')).toBe(c.now());
  });

  it('serialize persists refused + lastOk (never dead) and seeds a new instance', () => {
    const c = clock();
    const h = createServerHealth({ now: c.now });
    h.markRefused('a', 'R');
    h.markDead('a', 'D');
    h.markOk('b', 'O');
    const snap = h.serialize();
    expect(snap).toEqual({ refused: { a: { R: c.now() + REFUSED_TTL_MS } }, lastOk: { b: { O: c.now() } } });
    const restored = createServerHealth({ now: c.now, initial: snap });
    expect(restored.isRefused('a', 'R')).toBe(true);
    expect(restored.isDead('a', 'D')).toBe(false);
    expect(restored.lastOk('b', 'O')).toBe(c.now());
  });

  it('serialize prunes expired refusals', () => {
    const c = clock();
    const h = createServerHealth({ now: c.now });
    h.markRefused('a', 'R');
    c.advance(REFUSED_TTL_MS);
    expect(h.serialize().refused).toEqual({});
  });
});
