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

  it('latency: a /delay 200 before online is carried into online, and the poll keeps it fresh', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    const seen: Array<number | undefined> = [];
    health.onStateChange((s) => s.kind === 'online' && seen.push(s.latencyMs));
    health.start();
    health.feedDelay(200, 87); // WireGuard readiness probe
    health.feedEstablishedThenVerify(true, { exitIp: '5.62.19.134', country: 'NL' });
    expect(health.state).toMatchObject({ kind: 'online', latencyMs: 87 });
    const since = (health.state as { since: number }).since;
    health.feedDelay(200, 64);
    expect(health.state).toEqual({ kind: 'online', since, exitIp: '5.62.19.134', country: 'NL', latencyMs: 64 });
    health.feedDelay(200, 64); // unchanged: no new state event
    expect(seen).toEqual([87, 64]);
  });

  it('latency from a previous run is not carried across a restart', () => {
    const health = new PortHealth();
    health.start();
    health.feedDelay(200, 87);
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '5.62.19.134', country: 'NL' });
    expect((health.state as { latencyMs?: number }).latencyMs).toBeUndefined();
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

  it('a failed probe (error / no answer) on an online port drops it to retrying(unresponsive) — a wedged engine never exits', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US', latencyMs: 80 });

    health.feedDelay('error');
    expect(health.state).toMatchObject({ kind: 'retrying', reasonKey: 'unresponsive' });
  });

  it('an error probe while connecting/verifying is still a no-op (clash_api may not be listening yet)', () => {
    const health = new PortHealth();
    health.start();
    health.feedDelay('error');
    expect(health.state.kind).toBe('connecting');
    health.feedLog('established');
    health.feedDelay('error');
    expect(health.state.kind).toBe('verifying');
  });

  it('503 while still connecting is a transient no-op (sing-box keeps retrying internally)', () => {
    const health = new PortHealth();
    health.start();
    health.feedDelay(503);
    expect(health.state.kind).toBe('connecting');
  });

  it('auth-terminal -> failed(auth) with no retry timer: terminal, nothing respawns the port', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    let retryDue = 0;
    health.onRetryDue(() => (retryDue += 1));
    health.start();
    health.feedLog('auth-terminal');
    expect(health.state).toEqual({ kind: 'failed', reason: 'auth', untilMs: clock.now(), attempt: 1 });
    expect(clock.hasPending).toBe(false); // the connecting deadline is gone too
    expect(retryDue).toBe(0);
  });

  it('each successive retry attempt increases the back-off delay', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedDelay(504);
    const firstDelay = clock.pendingDelayMs!;
    clock.advance(firstDelay);
    clock.fire();

    health.feedDelay(504);
    const secondDelay = clock.pendingDelayMs!;
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('a listener that stops the port on `retrying` cancels the retry timer', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.onStateChange((st) => {
      if (st.kind === 'retrying') health.stop();
    });
    health.start();
    health.feedDelay(504);
    expect(health.state).toEqual({ kind: 'stopped' });
    expect(clock.hasPending).toBe(false);
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

  it('initialAttempt carries the back-off across a rebuilt PortHealth (spec §6.4: no reset per restart)', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule, initialAttempt: 5 });
    health.start();
    health.feedDelay(504);
    expect(health.state).toMatchObject({ kind: 'retrying', attempt: 6 });
    // attempt 5 of the schedule is 30 s * 2^5 = 16 min, ±20 % jitter — never the 30 s first step.
    expect(clock.pendingDelayMs!).toBeGreaterThanOrEqual(0.8 * 16 * 60_000);
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

  // ── signal gating: only act while connecting/verifying/online ──────────

  it('a late delay probe after stop() does not revive the port', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US' });
    health.stop();
    expect(health.state).toEqual({ kind: 'stopped' });

    health.feedDelay(200);
    health.feedLog('established');
    expect(health.state).toEqual({ kind: 'stopped' });
  });

  it('a late auth-terminal log after stop() does not revive the port', () => {
    const health = new PortHealth();
    health.start();
    health.stop();
    health.feedLog('auth-terminal');
    expect(health.state).toEqual({ kind: 'stopped' });
  });

  it('signals are ignored while failed, and do not bump the attempt counter', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('auth-terminal'); // -> failed(auth), attempt 1
    expect(health.state.kind).toBe('failed');
    const pendingBefore = clock.pendingDelayMs;

    health.feedLog('auth-terminal'); // ignored: not active
    health.feedDelay(504); // ignored: not active
    expect(health.state.kind).toBe('failed');
    if (health.state.kind === 'failed') {
      expect(health.state.attempt).toBe(1); // unchanged
    }
    expect(clock.pendingDelayMs).toBe(pendingBefore); // timer was not reset
  });

  it('repeated 504s while already retrying do not reset the back-off or livelock — onRetryDue still fires once', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    let retryDueCount = 0;
    health.onRetryDue(() => {
      retryDueCount += 1;
    });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US' });

    health.feedDelay(504); // online -> retrying, attempt 1
    const firstDelay = clock.pendingDelayMs!;

    // Flood of repeated 504s while already retrying: must not reset the timer or bump attempt.
    health.feedDelay(504);
    health.feedDelay(504);
    health.feedDelay(504);
    expect(clock.pendingDelayMs).toBe(firstDelay);
    if (health.state.kind === 'retrying') {
      expect(health.state.attempt).toBe(1);
    }

    clock.advance(firstDelay);
    clock.fire();
    expect(health.state.kind).toBe('connecting');
    expect(retryDueCount).toBe(1);
  });

  // ── feedExit ─────────────────────────────────────────────────────────────

  it('feedExit moves an active (online) port to retrying("exited")', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US' });

    health.feedExit(1);
    expect(health.state.kind).toBe('retrying');
    if (health.state.kind === 'retrying') {
      expect(health.state.reasonKey).toBe('exited');
    }
  });

  it('feedExit while connecting also moves to retrying("exited")', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    health.feedExit(134);
    expect(health.state.kind).toBe('retrying');
  });

  it('feedExit is ignored while already stopped', () => {
    const health = new PortHealth();
    health.start();
    health.stop();
    health.feedExit(1);
    expect(health.state).toEqual({ kind: 'stopped' });
  });

  // ── connecting deadline ───────────────────────────────────────────────────

  it('drops connecting -> retrying("unreachable") after the connecting deadline elapses with no signal', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule, connectingDeadlineMs: 90_000 });
    health.start();
    expect(clock.pendingDelayMs).toBe(90_000);

    clock.advance(90_000);
    clock.fire();

    expect(health.state.kind).toBe('retrying');
    if (health.state.kind === 'retrying') {
      expect(health.state.reasonKey).toBe('unreachable');
    }
  });

  it('the connecting deadline is cancelled once "established" arrives, so it never fires late', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule, connectingDeadlineMs: 90_000 });
    health.start();
    health.feedLog('established');
    health.feedEstablishedThenVerify(true, { exitIp: '1.2.3.4', country: 'US' });

    expect(clock.hasPending).toBe(false); // no stray deadline timer left armed
    expect(health.state.kind).toBe('online');
  });

  // ── giveUpAfter ───────────────────────────────────────────────────────────

  it('giveUpAfter=0 (default) never gives up: retrying keeps rescheduling indefinitely', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule });
    health.start();
    for (let i = 0; i < 5; i += 1) {
      health.feedDelay(504);
      expect(health.state.kind).toBe('retrying');
      clock.advance(clock.pendingDelayMs!);
      clock.fire();
      expect(health.state.kind).toBe('connecting');
    }
  });

  it('giveUpAfter=3 moves to stopped with giveUpReason set after 3 failed attempts, and schedules no further retry', () => {
    const clock = fakeClock();
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule, giveUpAfter: 3 });
    health.start();

    health.feedDelay(504); // attempt 1 -> retrying
    expect(health.state.kind).toBe('retrying');
    clock.advance(clock.pendingDelayMs!);
    clock.fire(); // -> connecting

    health.feedDelay(504); // attempt 2 -> retrying
    expect(health.state.kind).toBe('retrying');
    clock.advance(clock.pendingDelayMs!);
    clock.fire(); // -> connecting

    health.feedDelay(504); // attempt 3 -> give up
    expect(health.state).toEqual({ kind: 'stopped' });
    expect(health.giveUpReason).toBe('timeout');
    expect(clock.hasPending).toBe(false); // no retry timer scheduled — truly stopped
  });

  it('reviewer M-5: giveUpAfter as a getter is read live on each tick, not captured at construction', () => {
    const clock = fakeClock();
    let giveUpAfter = 0; // live Settings value; starts at "never"
    const health = new PortHealth({ now: clock.now, schedule: clock.schedule, giveUpAfter: () => giveUpAfter });
    health.start();

    // With 0 it keeps retrying however many times.
    for (let i = 0; i < 3; i += 1) {
      health.feedDelay(504);
      expect(health.state.kind).toBe('retrying');
      clock.advance(clock.pendingDelayMs!);
      clock.fire();
      expect(health.state.kind).toBe('connecting');
    }

    // The user lowers it in Settings; the very next failure (attempt 4 >= 2) gives up,
    // which a value captured at construction (0) never would.
    giveUpAfter = 2;
    health.feedDelay(504);
    expect(health.state).toEqual({ kind: 'stopped' });
    expect(health.giveUpReason).toBe('timeout');
    expect(clock.hasPending).toBe(false);
  });
});
