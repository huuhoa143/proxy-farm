import type { DelayResult, LogSignal, PortState } from '../../shared/contracts';
import { nextBackoffMs } from './backoff';

export type Scheduler = (ms: number, cb: () => void) => () => void;

export interface PortHealthOptions {
  /** @default Date.now */
  now?: () => number;
  /** Schedules `cb` to run after `ms`; returns a cancel function. @default setTimeout-based. */
  schedule?: Scheduler;
}

function defaultSchedule(ms: number, cb: () => void): () => void {
  const timer = setTimeout(cb, ms);
  return () => clearTimeout(timer);
}

/**
 * Drives one port's health state machine (spec §6.4):
 * `queued → connecting → verifying → online`, with `auth-terminal` dropping
 * to `failed(auth)` and a 504 (or losing an online connection) dropping to
 * `retrying` — both on the back-off schedule (spec §6.4), and both still
 * auto-retrying since `giveUpAfter` defaults to never ("failed is not given
 * up"). Timing is fully injectable so tests can drive it with a fake clock.
 */
export class PortHealth {
  private readonly now: () => number;
  private readonly schedule: Scheduler;
  private _state: PortState = { kind: 'queued' };
  private attempt = 0;
  private cancelPendingRetry: (() => void) | null = null;
  private readonly stateChangeCbs = new Set<(state: PortState) => void>();
  private readonly retryDueCbs = new Set<() => void>();

  constructor(opts: PortHealthOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  get state(): PortState {
    return this._state;
  }

  /** Marks the port as (re)starting: spawned, waiting for "established" or the first 200. */
  start(): void {
    this.clearPendingRetry();
    this.setState({ kind: 'connecting', since: this.now() });
  }

  /** Stops the port (user action): cancels any pending back-off retry. */
  stop(): void {
    this.clearPendingRetry();
    this.setState({ kind: 'stopped' });
  }

  /** Feeds a classified log signal (spec §6.4: `classifyLog`). */
  feedLog(sig: LogSignal): void {
    if (sig === 'established') {
      if (this._state.kind === 'queued' || this._state.kind === 'connecting' || this._state.kind === 'retrying') {
        this.clearPendingRetry();
        this.setState({ kind: 'verifying', since: this.now() });
      }
      return;
    }
    // 'auth-terminal': credentials rejected, terminal for this process — still retried later (not given up).
    this.scheduleRetry({ kind: 'failed', reason: 'auth' });
  }

  /** Feeds a `/delay` probe result's HTTP-status code (spec §6.4). */
  feedDelay(code: DelayResult['code']): void {
    if (code === 200) {
      // WireGuard never logs "established" — the first successful delay probe is its readiness signal.
      if (this._state.kind === 'queued' || this._state.kind === 'connecting') {
        this.clearPendingRetry();
        this.setState({ kind: 'verifying', since: this.now() });
      }
      return;
    }
    if (code === 504) {
      // Silent black hole (wrong key / unreachable server): always drops to a scheduled retry.
      this.scheduleRetry({ kind: 'retrying', reasonKey: 'timeout' });
      return;
    }
    if (code === 503) {
      // "Endpoint dead or not ready": only actionable once we'd already called it online — during
      // connecting/verifying sing-box keeps retrying internally, so this is a transient no-op.
      if (this._state.kind === 'online') {
        this.scheduleRetry({ kind: 'retrying', reasonKey: 'unreachable' });
      }
      return;
    }
    // code === 'error' (clash_api itself unreachable, e.g. process not up yet or just crashed):
    // intentionally a no-op here — process-exit handling is the Supervisor's job, not this probe's.
  }

  /**
   * Reports the result of the exit-IP verification performed while
   * `verifying` (spec §6.4). `info` is required when `exitOk` is true, since
   * the resulting `online` state carries the verified exit IP/country.
   */
  feedEstablishedThenVerify(exitOk: boolean, info?: { exitIp: string; country: string; latencyMs?: number }): void {
    if (this._state.kind !== 'verifying') return; // stray/late call outside the verifying phase — ignore
    if (exitOk) {
      if (!info) {
        throw new Error('PortHealth.feedEstablishedThenVerify: info.exitIp/country is required when exitOk is true');
      }
      this.attempt = 0;
      this.clearPendingRetry();
      this.setState({ kind: 'online', since: this.now(), exitIp: info.exitIp, country: info.country, latencyMs: info.latencyMs });
      return;
    }
    this.scheduleRetry({ kind: 'retrying', reasonKey: 'verify-failed' });
  }

  /** Subscribes to every state transition. Returns an unsubscribe function. */
  onStateChange(cb: (state: PortState) => void): () => void {
    this.stateChangeCbs.add(cb);
    return () => this.stateChangeCbs.delete(cb);
  }

  /** Subscribes to the back-off timer elapsing (signalling the caller to actually respawn the engine). */
  onRetryDue(cb: () => void): () => void {
    this.retryDueCbs.add(cb);
    return () => this.retryDueCbs.delete(cb);
  }

  private setState(state: PortState): void {
    this._state = state;
    for (const cb of this.stateChangeCbs) cb(state);
  }

  private clearPendingRetry(): void {
    if (this.cancelPendingRetry) {
      this.cancelPendingRetry();
      this.cancelPendingRetry = null;
    }
  }

  private scheduleRetry(partial: { kind: 'failed'; reason: 'auth' } | { kind: 'retrying'; reasonKey: string }): void {
    this.clearPendingRetry();
    const delayMs = nextBackoffMs(this.attempt);
    const untilMs = this.now() + delayMs;
    this.attempt += 1;

    if (partial.kind === 'failed') {
      this.setState({ kind: 'failed', reason: partial.reason, untilMs, attempt: this.attempt });
    } else {
      this.setState({ kind: 'retrying', untilMs, attempt: this.attempt, reasonKey: partial.reasonKey });
    }

    this.cancelPendingRetry = this.schedule(delayMs, () => {
      this.cancelPendingRetry = null;
      this.setState({ kind: 'connecting', since: this.now() });
      for (const cb of this.retryDueCbs) cb();
    });
  }
}
