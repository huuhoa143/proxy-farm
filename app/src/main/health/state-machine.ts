import type { DelayResult, LogSignal, PortState } from '../../shared/contracts';
import { nextBackoffMs } from './backoff';

export type Scheduler = (ms: number, cb: () => void) => () => void;

/** How long `connecting` is allowed to wait for "established"/first-200 before it's treated as unreachable. */
const DEFAULT_CONNECTING_DEADLINE_MS = 90_000;

export interface PortHealthOptions {
  /** @default Date.now */
  now?: () => number;
  /** Schedules `cb` to run after `ms`; returns a cancel function. @default setTimeout-based. */
  schedule?: Scheduler;
  /** @default 90_000 (spec §6.4) */
  connectingDeadlineMs?: number;
  /**
   * Consecutive failed attempts (since last `online`) before giving up entirely.
   * 0 = never (spec `Settings.giveUpAfter`). @default 0
   *
   * May be a function so the live `Settings.giveUpAfter` is read on each retry tick
   * rather than captured once at construction (reviewer M-5): a user raising/lowering
   * it in Settings then takes effect without rebuilding the port. A plain number is
   * still accepted and treated as a constant.
   */
  giveUpAfter?: number | (() => number);
}

function defaultSchedule(ms: number, cb: () => void): () => void {
  const timer = setTimeout(cb, ms);
  // Background scheduling only — never itself keep the process alive (and,
  // incidentally, never keep a test runner hanging on a 90s connecting deadline).
  timer.unref?.();
  return () => clearTimeout(timer);
}

type RetryKind = { kind: 'failed'; reason: 'auth' } | { kind: 'retrying'; reasonKey: string };

/**
 * Drives one port's health state machine (spec §6.4):
 * `queued → connecting → verifying → online`, with `auth-terminal` dropping
 * to `failed(auth)` and a 504 (or losing an online connection, or an
 * unexpected process exit) dropping to `retrying` — both on the back-off
 * schedule, and both still auto-retrying since `giveUpAfter` defaults to
 * never ("failed is not given up"). Once `giveUpAfter` is reached the port
 * moves to a terminal `stopped` (see `giveUpReason`) and no further retry is
 * scheduled.
 *
 * Signals (`feedLog`/`feedDelay`/`feedExit`) are only ever acted on while the
 * port is `connecting`, `verifying`, or `online` — a stray/late signal while
 * `retrying`/`failed`/`stopped`/`queued` is silently ignored (no timer
 * reset, no attempt bump), so e.g. a flood of repeated 504s while already
 * `retrying` can't reset or livelock the back-off, and nothing can revive a
 * port after `stop()`.
 *
 * Timing is fully injectable so tests can drive it with a fake clock.
 */
export class PortHealth {
  private readonly now: () => number;
  private readonly schedule: Scheduler;
  private readonly connectingDeadlineMs: number;
  /** Read live on each retry tick (reviewer M-5), never captured as a number. */
  private readonly getGiveUpAfter: () => number;

  private _state: PortState = { kind: 'queued' };
  private attempt = 0;
  /** The latest `/delay` round trip since the last start, carried into `online`. */
  private lastLatencyMs: number | undefined;
  private cancelPendingRetry: (() => void) | null = null;
  private cancelConnectingDeadline: (() => void) | null = null;
  private readonly stateChangeCbs = new Set<(state: PortState) => void>();
  private readonly retryDueCbs = new Set<() => void>();

  /** Set when `giveUpAfter` is reached; the reason `stopped` doesn't otherwise carry (contracts' `PortState` has none). */
  giveUpReason: string | undefined;

  constructor(opts: PortHealthOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.connectingDeadlineMs = opts.connectingDeadlineMs ?? DEFAULT_CONNECTING_DEADLINE_MS;
    const giveUpAfter = opts.giveUpAfter ?? 0;
    this.getGiveUpAfter = typeof giveUpAfter === 'function' ? giveUpAfter : () => giveUpAfter;
  }

  get state(): PortState {
    return this._state;
  }

  /** Marks the port as (re)starting: spawned, waiting for "established" or the first 200. */
  start(): void {
    this.clearPendingRetry();
    this.giveUpReason = undefined;
    this.lastLatencyMs = undefined;
    this.enterConnecting();
  }

  /** Stops the port (user action): cancels any pending back-off retry/deadline. */
  stop(): void {
    this.clearPendingRetry();
    this.clearConnectingDeadline();
    this.setState({ kind: 'stopped' });
  }

  /** Feeds a classified log signal (spec §6.4: `classifyLog`). Ignored unless currently active (see class docs). */
  feedLog(sig: LogSignal): void {
    if (!this.isActive()) return;
    if (sig === 'established') {
      if (this._state.kind === 'connecting') {
        this.clearConnectingDeadline();
        this.setState({ kind: 'verifying', since: this.now() });
      }
      return;
    }
    // 'auth-terminal': credentials rejected, terminal for this process — still retried later (not given up).
    this.scheduleRetry({ kind: 'failed', reason: 'auth' });
  }

  /**
   * Feeds a `/delay` probe result (spec §6.4): its HTTP-status code and, for a 200, the
   * round trip in ms, which becomes the port's `latencyMs` (kept fresh while online by
   * the periodic poll). Ignored unless currently active (see class docs).
   */
  feedDelay(code: DelayResult['code'], ms?: number): void {
    if (!this.isActive()) return;
    if (code === 200) {
      if (ms !== undefined) this.lastLatencyMs = ms;
      // WireGuard never logs "established" — the first successful delay probe is its readiness signal.
      if (this._state.kind === 'connecting') {
        this.clearConnectingDeadline();
        this.setState({ kind: 'verifying', since: this.now() });
      } else if (this._state.kind === 'online' && ms !== undefined && ms !== this._state.latencyMs) {
        this.setState({ ...this._state, latencyMs: ms });
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
    // intentionally a no-op here — process-exit handling is feedExit's job, not this probe's.
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
      const latencyMs = info.latencyMs ?? this.lastLatencyMs;
      this.setState({ kind: 'online', since: this.now(), exitIp: info.exitIp, country: info.country, ...(latencyMs !== undefined ? { latencyMs } : {}) });
      return;
    }
    this.scheduleRetry({ kind: 'retrying', reasonKey: 'verify-failed' });
  }

  /**
   * Feeds an unexpected engine-process exit (e.g. `EngineProcess.onExit`).
   * Ignored unless currently active (see class docs) — a late/duplicate
   * exit report while already `retrying`/`failed`/`stopped` can't reset or
   * duplicate the pending back-off.
   */
  feedExit(_code: number | null): void {
    if (!this.isActive()) return;
    this.scheduleRetry({ kind: 'retrying', reasonKey: 'exited' });
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

  /** True while signals are actionable: spawned-and-waiting, verifying, or already online. */
  private isActive(): boolean {
    return this._state.kind === 'connecting' || this._state.kind === 'verifying' || this._state.kind === 'online';
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

  private clearConnectingDeadline(): void {
    if (this.cancelConnectingDeadline) {
      this.cancelConnectingDeadline();
      this.cancelConnectingDeadline = null;
    }
  }

  /** Enters `connecting` and arms the ~90s deadline that drops to `retrying('unreachable')` if nothing happens. */
  private enterConnecting(): void {
    this.clearConnectingDeadline();
    this.setState({ kind: 'connecting', since: this.now() });
    this.cancelConnectingDeadline = this.schedule(this.connectingDeadlineMs, () => {
      this.cancelConnectingDeadline = null;
      if (this._state.kind === 'connecting') {
        this.scheduleRetry({ kind: 'retrying', reasonKey: 'unreachable' });
      }
    });
  }

  private scheduleRetry(partial: RetryKind): void {
    this.clearConnectingDeadline();
    this.clearPendingRetry();
    const delayMs = nextBackoffMs(this.attempt);
    const untilMs = this.now() + delayMs;
    this.attempt += 1;

    const giveUpAfter = this.getGiveUpAfter();
    if (giveUpAfter > 0 && this.attempt >= giveUpAfter) {
      this.giveUpReason = partial.kind === 'failed' ? partial.reason : partial.reasonKey;
      this.setState({ kind: 'stopped' });
      return; // truly given up — no timer, no further auto-retry
    }

    if (partial.kind === 'failed') {
      this.setState({ kind: 'failed', reason: partial.reason, untilMs, attempt: this.attempt });
    } else {
      this.setState({ kind: 'retrying', untilMs, attempt: this.attempt, reasonKey: partial.reasonKey });
    }

    this.cancelPendingRetry = this.schedule(delayMs, () => {
      this.cancelPendingRetry = null;
      this.enterConnecting();
      for (const cb of this.retryDueCbs) cb();
    });
  }
}
