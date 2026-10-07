import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortRow } from '../../shared/contracts';
import { createAutoRotateScheduler } from './auto-rotate';

function row(key: string, autoRotateMin: number, enabled = true): PortRow {
  return {
    key,
    providerId: 'zoogvpn',
    accountId: 'z1',
    label: key,
    country: 'NL',
    city: 'Amsterdam',
    proxyPort: 29001,
    enabled,
    state: { kind: 'online', since: 0, exitIp: '1.1.1.1', country: 'NL' },
    autoRotateMin,
  };
}

describe('auto-rotate scheduler (spec §4.2/§6.5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rotates an enabled row every N minutes', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5)]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(rotate).toHaveBeenCalledWith('a');
    expect(rotate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('does not schedule a row with autoRotateMin = 0', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 0)]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('does not schedule a disabled row even with autoRotateMin > 0', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5, false)]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('cancels the timer when a row is removed from a later sync() (stop/remove)', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5)]);
    s.sync([]); // row stopped/removed
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('cancels the timer when a row is disabled in a later sync()', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5)]);
    s.sync([row('a', 5, false)]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('cancels the timer when autoRotateMin is set to 0 in a later sync()', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5)]);
    s.sync([row('a', 0)]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('replaces the timer immediately when autoRotateMin changes, not waiting out the old interval', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 10)]);
    s.sync([row('a', 2)]); // changed from 10 to 2 minutes
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(rotate).toHaveBeenCalledTimes(1);
    // had the old 10-minute timer survived, nothing would have fired by t=8min; confirm
    // the new 2-minute cadence is what's running, not a leftover old one plus a new one
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('a rotate() rejection does not stop future ticks or throw out of sync()', async () => {
    const rotate = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5)]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('stopAll() cancels every running timer', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5), row('b', 5)]);
    s.stopAll();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('tracks multiple rows independently, each on its own cadence', async () => {
    const rotate = vi.fn(async () => undefined);
    const s = createAutoRotateScheduler({ rotate });
    s.sync([row('a', 5), row('b', 10)]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(rotate.mock.calls).toEqual([['a']]);
    // at t=10min, 'a' fires its 2nd tick (5,10,...) and 'b' fires its 1st (10,...)
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(rotate.mock.calls).toEqual([['a'], ['a'], ['b']]);
  });
});
