import { describe, expect, it } from 'vitest';
import { createAttemptLimiter, createWgKeyGuard } from './provider-safety';

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

describe('createWgKeyGuard', () => {
  it('locks an unproven account after 3 attempts in a row with no handshake', () => {
    const guard = createWgKeyGuard({ now: () => 42 });
    expect(guard.recordNoHandshake('a', false)).toBe(false);
    expect(guard.recordNoHandshake('a', false)).toBe(false);
    expect(guard.recordNoHandshake('a', false)).toBe(true);
    expect(guard.isLocked('a')).toBe(true);
    expect(guard.serialize()).toEqual({ a: 42 });
    expect(guard.recordNoHandshake('a', false)).toBe(false); // already locked: no second lock event
  });

  it('never locks an account that has handshaken before', () => {
    const guard = createWgKeyGuard();
    for (let i = 0; i < 10; i++) expect(guard.recordNoHandshake('a', true)).toBe(false);
    expect(guard.isLocked('a')).toBe(false);
  });

  it('a handshake resets the count', () => {
    const guard = createWgKeyGuard();
    guard.recordNoHandshake('a', false);
    guard.recordNoHandshake('a', false);
    guard.recordHandshake('a');
    expect(guard.recordNoHandshake('a', false)).toBe(false);
    expect(guard.recordNoHandshake('a', false)).toBe(false);
  });

  it('rearm allows exactly one more attempt; forget starts over', () => {
    const guard = createWgKeyGuard({ initial: { a: 1 } }); // a persisted lock survives a restart
    expect(guard.isLocked('a')).toBe(true);
    guard.rearm('a');
    expect(guard.isLocked('a')).toBe(false);
    expect(guard.recordNoHandshake('a', false)).toBe(true);
    guard.forget('a');
    expect(guard.isLocked('a')).toBe(false);
    expect(guard.recordNoHandshake('a', false)).toBe(false);
  });

  it('rearm on an account that is not locked changes nothing', () => {
    const guard = createWgKeyGuard();
    guard.rearm('a');
    expect(guard.recordNoHandshake('a', false)).toBe(false);
  });
});
