import { describe, expect, it } from 'vitest';
import { PortHealth } from './state-machine';

/** Deterministic clock + scheduler: `fire()` runs (and clears) whatever was last scheduled. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  let pending: { ms: number; cb: () => void } | null = null;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    schedule: (ms: number, cb: () => void) => {
      pending = { ms, cb };
      return () => {
        pending = null;
      };
    },
    fire: () => {
      const p = pending;
      pending = null;
      p?.cb();
    },
    get pendingDelayMs() {
      return pending?.ms ?? null;
    },
    get hasPending() {
      return pending !== null;
    },
  };
}

describe('PortHealth', () => {
  it('starts queued, then connecting on start()', () => {
    const health = new PortHealth();
    expect(health.state).toEqual({ kind: 'queued' });
    health.start();
    expect(health.state.kind).toBe('connecting');
  });

  it('moves connecting -> verifying on an "established" log signal', () => {
    const health = new PortHealth();
    health.start();
    health.feedLog('established');
    expect(health.state.kind).toBe('verifying');
  });

  it('moves connecting -> verifying on a 200 delay result (WireGuard has no "established" log)', () => {
    const health = new PortHealth();
    health.start();
    health.feedDelay(200);
    expect(health.state.kind).toBe('verifying');
  });

  it('moves verifying -> online with exitIp/country/latencyMs when exitOk is true', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '5.62.19.134', country: 'NL', latencyMs: 42 });
    expect(health.state).toEqual({ kind: 'online', since: clock.now(), exitIp: '5.62.19.134', country: 'NL', latencyMs: 42 });
  });

  it('moves verifying -> retrying with a scheduled back-off when exitOk is false', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(false);
    expect(health.state.kind).toBe('retrying');
    if (health.state.kind === 'retrying') {
      expect(health.state.attempt).toBe(1);
      expect(health.state.untilMs).toBeGreaterThan(clock.now());
    }
    expect(clock.hasPending).toBe(true);
  });

  it('auto-transitions retrying -> connecting once the back-off timer fires, and notifies onRetryDue', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    let retryDueCount = 0;
    health.onRetryDue(() => {
      retryDueCount += 1;
    });

    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(false);
    expect(health.state.kind).toBe('retrying');

    clock.advance(clock.pendingDelayMs!);
    clock.fire();

    expect(health.state.kind).toBe('connecting');
    expect(retryDueCount).toBe(1);
  });

  it('504 on an online port drops it to retrying with backoff', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US' });
    expect(health.state.kind).toBe('online');

    health.feedDelay(504);
    expect(health.state.kind).toBe('retrying');
  });

  it('503 on an online port drops it to retrying', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US' });

    health.feedDelay(503);
    expect(health.state.kind).toBe('retrying');
  });

  it('503 while still connecting is a transient no-op (sing-box keeps retrying internally)', () => {
    const health = new PortHealth();
    health.start();
    health.feedDelay(503);
    expect(health.state.kind).toBe('connecting');
  });

  it('auth-terminal -> failed(auth), still scheduled for a later retry (not given up)', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('auth-terminal');
    expect(health.state.kind).toBe('failed');
    if (health.state.kind === 'failed') {
      expect(health.state.reason).toBe('auth');
      expect(health.state.attempt).toBe(1);
    }
    expect(clock.hasPending).toBe(true);

    clock.advance(clock.pendingDelayMs!);
    clock.fire();
    expect(health.state.kind).toBe('connecting');
  });

  it('each successive retry/failed attempt increases the back-off delay', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('auth-terminal');
    const firstDelay = clock.pendingDelayMs!;
    clock.advance(firstDelay);
    clock.fire();

    health.feedLog('auth-terminal');
    const secondDelay = clock.pendingDelayMs!;
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('resets the attempt counter back to 0 once online', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(false); // attempt -> 1
    clock.advance(clock.pendingDelayMs!);
    clock.fire(); // back to connecting

    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '9.9.9.9', country: 'FR' });
    expect(health.state.kind).toBe('online');

    health.feedDelay(504); // first retrying after being online again
    expect(health.state.kind).toBe('retrying');
    if (health.state.kind === 'retrying') {
      expect(health.state.attempt).toBe(1); // not 2 — confirms the counter reset on going online
    }
  });

  it('stop() cancels any pending retry timer and moves to stopped', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(false);
    expect(clock.hasPending).toBe(true);

    health.stop();
    expect(health.state).toEqual({ kind: 'stopped' });
  });

  it('feedEstablishedThenVerify throws if exitOk=true but no exit info is given', () => {
    const health = new PortHealth();
    health.start();
    health.feedLog('established');
    expect(() => health.feedEstablishedThenVerify(true)).toThrow(/exitIp/);
  });

  it('onStateChange fires on every transition', () => {
    const health = new PortHealth();
    const seen: string[] = [];
    health.onStateChange((s) => seen.push(s.kind));
    health.start();
    health.feedLog('established');
    expect(seen).toEqual(['connecting', 'verifying']);
  });
});
