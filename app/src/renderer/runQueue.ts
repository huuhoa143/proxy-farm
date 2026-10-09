export interface QueueRun {
  /** Stop taking items; the ones already running still finish. */
  cancel(): void;
  /** Resolves once every started item settled (never rejects). */
  done: Promise<void>;
}

/**
 * Runs `worker` over `items`, at most `concurrency` at a time, in order. Check all
 * (spec §4.1) runs here, in the renderer: main's `testPort` is already one probe per
 * call, and only the renderer knows when the user presses Stop. A worker that throws
 * counts as settled; the caller records its own failures.
 */
export function runQueue<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): QueueRun {
  let next = 0;
  let cancelled = false;
  async function lane(): Promise<void> {
    while (!cancelled && next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch {
        // Settled all the same: one bad item must not stall its lane.
      }
    }
  }
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane);
  return {
    cancel: () => {
      cancelled = true;
    },
    done: Promise.all(lanes).then(() => undefined),
  };
}
