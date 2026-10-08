import { describe, expect, it } from 'vitest';
import { createAttemptLimiter } from './provider-safety';

describe('createAttemptLimiter', () => {
  it('lets a burst of 6 through per account, then one every 10 s', () => {
    let t = 0;
    const limiter = createAttemptLimiter({ now: () => t });
    for (let i = 0; i < 6; i++) expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(10_000);
    expect(limiter.take('b')).toBe(0); // budgets are per account
    t += 4_000;
    expect(limiter.take('a')).toBe(6_000); // a refused take consumes nothing
    t += 6_000;
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(10_000);
  });

  it('never saves up more than one minute of attempts', () => {
    let t = 0;
    const limiter = createAttemptLimiter({ now: () => t, perMinute: 6 });
    t += 60 * 60_000;
    for (let i = 0; i < 6; i++) expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeGreaterThan(0);
  });
});
