import { describe, expect, it } from 'vitest';
import { createServerMemory, DEFAULT_BAD_TTL_MS } from './server-memory';

describe('server-memory (spec §6.4 bad-IP failover)', () => {
  function clock(start = 1_000_000) {
    const t = { now: start };
    return { now: () => t.now, advance: (ms: number) => (t.now += ms) };
  }

  it('an unmarked server is neither bad nor has a lastOk', () => {
    const mem = createServerMemory();
    expect(mem.isBad('1.1.1.1')).toBe(false);
    expect(mem.lastOk('1.1.1.1')).toBeUndefined();
  });

  it('markBad holds for the TTL (default 2 h) and then clears', () => {
    const c = clock();
    const mem = createServerMemory({ now: c.now });
    mem.markBad('1.1.1.1');
    expect(mem.isBad('1.1.1.1')).toBe(true);
    c.advance(DEFAULT_BAD_TTL_MS - 1);
    expect(mem.isBad('1.1.1.1')).toBe(true);
    c.advance(1); // exactly at expiry
    expect(mem.isBad('1.1.1.1')).toBe(false);
  });

  it('respects a custom badTtlMs', () => {
    const c = clock();
    const mem = createServerMemory({ now: c.now, badTtlMs: 5_000 });
    mem.markBad('2.2.2.2');
    c.advance(4_999);
    expect(mem.isBad('2.2.2.2')).toBe(true);
    c.advance(1);
    expect(mem.isBad('2.2.2.2')).toBe(false);
  });

  it('markOk records a lastOk timestamp and clears any bad mark', () => {
    const c = clock();
    const mem = createServerMemory({ now: c.now });
    mem.markBad('3.3.3.3');
    expect(mem.isBad('3.3.3.3')).toBe(true);
    c.advance(1_000);
    mem.markOk('3.3.3.3');
    expect(mem.isBad('3.3.3.3')).toBe(false);
    expect(mem.lastOk('3.3.3.3')).toBe(1_001_000);
  });

  it('isBad is per-server, not global', () => {
    const mem = createServerMemory();
    mem.markBad('a');
    expect(mem.isBad('a')).toBe(true);
    expect(mem.isBad('b')).toBe(false);
  });
});
