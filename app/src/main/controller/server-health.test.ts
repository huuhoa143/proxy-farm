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

  it('workedRecently: a recent lastOk on another server, within the window', () => {
    const c = clock();
    const h = createServerHealth({ now: c.now });
    expect(h.workedRecently('a', 1000)).toBe(false);
    h.markOk('a', 'S1');
    expect(h.workedRecently('a', 1000)).toBe(true);
    expect(h.workedRecently('a', 1000, 'S1')).toBe(false); // only that very server
    expect(h.workedRecently('b', 1000)).toBe(false); // per account
    c.advance(1000);
    expect(h.workedRecently('a', 1000)).toBe(false);
  });

  it('forgetMarks drops the account\'s refused and dead marks, keeps lastOk and other accounts', () => {
    const h = createServerHealth();
    h.markOk('a', 'O');
    h.markRefused('a', 'R');
    h.markDead('a', 'D');
    h.markRefused('b', 'R');
    h.forgetMarks('a');
    expect(h.isUsable('a', 'R')).toBe(true);
    expect(h.isUsable('a', 'D')).toBe(true);
    expect(h.lastOk('a', 'O')).toBeTypeOf('number');
    expect(h.isRefused('b', 'R')).toBe(true);
    expect(h.serialize().refused).toEqual({ b: { R: expect.any(Number) } });
  });

  it('serialize prunes expired refusals', () => {
    const c = clock();
    const h = createServerHealth({ now: c.now });
    h.markRefused('a', 'R');
    c.advance(REFUSED_TTL_MS);
    expect(h.serialize().refused).toEqual({});
  });

  describe('marks follow the machine: keyed by resolved IP (spec §6.8)', () => {
    const SHARED = '185.177.229.121'; // de7.webunlim.com and fr4.webunlim.com, 2026-10-08

    it('a refusal under one hostname applies to every hostname on the same IP', () => {
      const h = createServerHealth();
      h.noteIp('de7.webunlim.com', SHARED);
      h.markRefused('a', 'de7.webunlim.com');
      expect(h.isRefused('a', 'fr4.webunlim.com')).toBe(false); // its IP is not known yet
      h.noteIp('fr4.webunlim.com', SHARED);
      expect(h.isRefused('a', 'fr4.webunlim.com')).toBe(true);
      expect(h.isRefused('a', SHARED)).toBe(true);
      expect(h.isRefused('b', 'fr4.webunlim.com')).toBe(false); // still per account
    });

    it('dead marks and lastOk are shared the same way; markOk under one name clears both', () => {
      const h = createServerHealth();
      h.noteIp('de7.webunlim.com', SHARED);
      h.noteIp('fr4.webunlim.com', SHARED);
      h.markDead('a', 'de7.webunlim.com');
      expect(h.isDead('a', 'fr4.webunlim.com')).toBe(true);
      h.markOk('a', 'fr4.webunlim.com');
      expect(h.isUsable('a', 'de7.webunlim.com')).toBe(true);
      expect(h.lastOk('a', 'de7.webunlim.com')).toBeTypeOf('number');
      expect(h.workedRecently('a', 60_000, 'de7.webunlim.com')).toBe(false); // the same machine
    });

    it('a mark made while the hostname was unresolved moves onto its IP once it resolves', () => {
      const h = createServerHealth();
      h.markRefused('a', 'de7.webunlim.com');
      expect(h.isRefused('a', 'de7.webunlim.com')).toBe(true);
      expect(h.noteIp('de7.webunlim.com', SHARED)).toBe(true);
      expect(h.noteIp('de7.webunlim.com', SHARED)).toBe(false); // unchanged
      expect(h.serialize().refused).toEqual({ a: { [SHARED]: expect.any(Number) } });
      h.noteIp('fr4.webunlim.com', SHARED);
      expect(h.isRefused('a', 'fr4.webunlim.com')).toBe(true);
    });

    it('migrates the hostname-keyed marks persisted by 0.1.0, and persists the hostname → IP map', () => {
      const c = clock();
      const until = c.now() + 1000;
      // 0.1.0 wrote marks keyed by hostname and no `ips`.
      const old = createServerHealth({ now: c.now, initial: { refused: { a: { 'de7.webunlim.com': until } }, lastOk: { a: { 'nl1.webunlim.com': 5 } } } });
      expect(old.isRefused('a', 'de7.webunlim.com')).toBe(true); // honoured before any lookup
      old.noteIp('de7.webunlim.com', SHARED);
      old.noteIp('nl1.webunlim.com', '185.107.80.1');
      const snap = old.serialize();
      expect(snap).toEqual({
        refused: { a: { [SHARED]: until } },
        lastOk: { a: { '185.107.80.1': 5 } },
        ips: { 'de7.webunlim.com': SHARED, 'nl1.webunlim.com': '185.107.80.1' },
      });
      // After a restart the map is known before anything resolves.
      const restored = createServerHealth({ now: c.now, initial: { ...snap, ips: { ...snap.ips, 'fr4.webunlim.com': SHARED } } });
      expect(restored.isRefused('a', 'fr4.webunlim.com')).toBe(true);
      // A file with both a hostname mark and its IP's keeps the later one, under the IP.
      const both = createServerHealth({
        now: c.now,
        initial: { refused: { a: { 'de7.webunlim.com': until, [SHARED]: until + 5 } }, lastOk: {}, ips: { 'de7.webunlim.com': SHARED } },
      });
      expect(both.serialize().refused).toEqual({ a: { [SHARED]: until + 5 } });
    });

    it('forgetRefusalsSince drops only the refusals set at or after that time', () => {
      const c = clock();
      const h = createServerHealth({ now: c.now });
      h.markRefused('a', 'old');
      c.advance(10);
      const since = c.now();
      h.markRefused('a', 'new');
      h.markRefused('b', 'new');
      h.forgetRefusalsSince('a', since);
      expect(h.isRefused('a', 'old')).toBe(true);
      expect(h.isRefused('a', 'new')).toBe(false);
      expect(h.isRefused('b', 'new')).toBe(true);
    });
  });
});
