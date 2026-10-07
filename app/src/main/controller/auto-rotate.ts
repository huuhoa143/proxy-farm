import type { PortRow } from '../../shared/contracts';

export type Scheduler = (ms: number, cb: () => void) => () => void;

export interface AutoRotateSchedulerOptions {
  /** Called every `row.autoRotateMin` minutes for an enabled row with that set > 0. */
  rotate(key: string): Promise<unknown>;
  /** Schedules `cb` to run after `ms`; returns a cancel function. @default setInterval-based. */
  schedule?: Scheduler;
}

export interface AutoRotateScheduler {
  /**
   * Reconciles running timers against the current desired set (enabled rows with
   * `autoRotateMin > 0`). Call this after every state change that could affect it:
   * `setAutoRotate`, `stopPort`/`removePort`, `startPort`, and once at app startup with
   * the loaded rows. A row whose `autoRotateMin` changed gets its timer replaced (so a
   * new interval takes effect immediately rather than waiting out the old one); a row
   * that disappeared or was disabled gets its timer cancelled.
   */
  sync(rows: PortRow[]): void;
  /** Cancels every timer (e.g. on app quit). */
  stopAll(): void;
}

function defaultSchedule(ms: number, cb: () => void): () => void {
  const timer = setInterval(cb, ms);
  return () => clearInterval(timer);
}

/**
 * Drives §4.2/§6.5's "auto-rotate every N minutes" (contracts' `setAutoRotate`): one
 * interval timer per enabled port row with `autoRotateMin > 0`, calling `rotate(key)`
 * on each tick. A rotate error never crashes the scheduler or cancels future ticks —
 * errors are the rotate implementation's job to turn into port state (reviewer item 7).
 */
export function createAutoRotateScheduler(options: AutoRotateSchedulerOptions): AutoRotateScheduler {
  const schedule = options.schedule ?? defaultSchedule;
  // key -> { minutes, cancel }
  const timers = new Map<string, { minutes: number; cancel: () => void }>();

  function start(key: string, minutes: number): void {
    const cancel = schedule(minutes * 60_000, () => {
      void options.rotate(key).catch(() => undefined);
    });
    timers.set(key, { minutes, cancel });
  }

  function sync(rows: PortRow[]): void {
    const desired = new Map(rows.filter((r) => r.enabled && r.autoRotateMin > 0).map((r) => [r.key, r.autoRotateMin]));

    // Snapshot the existing entries before touching `timers` at all: mutating a Map
    // (even deleting-then-reinserting the very key currently being visited) while a
    // `for...of` is still iterating it is a live-iterator hazard that can revisit the
    // reinserted key indefinitely. Decide everything from static snapshots first, then
    // apply.
    const existing = [...timers.entries()];
    const toReplace: Array<[string, number]> = [];
    const toCancel: string[] = [];

    for (const [key, entry] of existing) {
      const wantMinutes = desired.get(key);
      if (wantMinutes === undefined) {
        toCancel.push(key);
      } else if (wantMinutes !== entry.minutes) {
        toReplace.push([key, wantMinutes]);
        desired.delete(key);
      } else {
        desired.delete(key); // unchanged: leave its timer running as-is
      }
    }

    for (const key of toCancel) {
      timers.get(key)?.cancel();
      timers.delete(key);
    }
    for (const [key, minutes] of toReplace) {
      timers.get(key)?.cancel();
      timers.delete(key);
      start(key, minutes);
    }
    for (const [key, minutes] of desired) {
      start(key, minutes);
    }
  }

  function stopAll(): void {
    for (const entry of timers.values()) entry.cancel();
    timers.clear();
  }

  return { sync, stopAll };
}
