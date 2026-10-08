import { describe, expect, it } from 'vitest';
import { nextBackoffMs } from './backoff';

const noJitter = () => 0.5; // rng midpoint => jitter term is exactly 0

describe('nextBackoffMs', () => {
  it('starts at 30s for attempt 0 (no jitter)', () => {
    expect(nextBackoffMs(0, noJitter)).toBe(30_000);
  });

  it('doubles each attempt: 1min, 2min, 4min (no jitter)', () => {
    expect(nextBackoffMs(1, noJitter)).toBe(60_000);
    expect(nextBackoffMs(2, noJitter)).toBe(120_000);
    expect(nextBackoffMs(3, noJitter)).toBe(240_000);
  });

  it('caps at 30 minutes for large attempts (no jitter)', () => {
    expect(nextBackoffMs(10, noJitter)).toBe(30 * 60_000);
    expect(nextBackoffMs(50, noJitter)).toBe(30 * 60_000);
  });

  it('applies jitter within ±20% of the base value', () => {
    const base = 240_000; // attempt 3
    const high = nextBackoffMs(3, () => 1); // max positive jitter
    const low = nextBackoffMs(3, () => 0); // max negative jitter
    expect(high).toBeGreaterThan(base);
    expect(high).toBeLessThanOrEqual(base * 1.2);
    expect(low).toBeLessThan(base);
    expect(low).toBeGreaterThanOrEqual(base * 0.8);
  });

  it('never returns a negative delay', () => {
    expect(nextBackoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('clamps after jitter: max positive jitter on an already-capped delay never exceeds the 30min cap', () => {
    expect(nextBackoffMs(10, () => 1)).toBe(30 * 60_000);
    expect(nextBackoffMs(50, () => 1)).toBe(30 * 60_000);
  });

  it('treats a negative attempt as attempt 0', () => {
    expect(nextBackoffMs(-5, noJitter)).toBe(30_000);
  });

  it('defaults to Math.random when no rng is given (stays within bounds)', () => {
    const v = nextBackoffMs(2);
    expect(v).toBeGreaterThanOrEqual(120_000 * 0.8);
    expect(v).toBeLessThanOrEqual(120_000 * 1.2);
  });
});
