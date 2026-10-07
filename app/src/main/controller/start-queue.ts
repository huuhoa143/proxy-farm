export interface StartQueueOptions {
  /** §6.4: at most this many starts in flight at once. Default 3. */
  maxConcurrent?: number;
  /** §6.4: consecutive launches at least this far apart. Default 2000ms. */
  minGapMs?: number;
  /** Upper bound of the random gap. Default 5000ms. */
  maxGapMs?: number;
  /** Injectable for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
}

type Task = () => Promise<void>;

/**
 * Staggered start queue (spec §6.4 and §6.7): starts are queued at <= `maxConcurrent`
 * concurrent, with consecutive launches spaced a random `minGapMs`-`maxGapMs` apart.
 * Used for app start, resume-from-suspend, and any bulk `startPorts` call.
 */
export interface StartQueue {
  /** Queue a start for `key`. Re-enqueuing a key still waiting replaces its task
   * rather than running it twice. */
  enqueue(key: string, task: Task): void;
  /** Remove a still-waiting key; a no-op if it already started. */
  cancel(key: string): void;
  clear(): void;
  isQueued(key: string): boolean;
  readonly inFlight: number;
  /** Highest number of concurrent tasks observed so far (diagnostics/tests). */
  readonly peak: number;
}

export function createStartQueue(options: StartQueueOptions = {}): StartQueue {
  const max = options.maxConcurrent ?? 3;
  const minGap = options.minGapMs ?? 2000;
  const maxGap = options.maxGapMs ?? 5000;
  const random = options.random ?? Math.random;

  let pending: Array<{ key: string; task: Task }> = [];
  const running = new Set<string>();
  let nextAllowedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let peak = 0;

  function pump(): void {
    if (timer) return;
    if (!pending.length || running.size >= max) return;
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    const next = pending.find((p) => !running.has(p.key));
    if (!next) return;
    pending = pending.filter((p) => p !== next);
    running.add(next.key);
    peak = Math.max(peak, running.size);
    nextAllowedAt = Date.now() + minGap + Math.floor(random() * (maxGap - minGap));
    void next
      .task()
      .catch(() => undefined)
      .finally(() => {
        running.delete(next.key);
        pump();
      });
    pump();
  }

  return {
    enqueue(key, task) {
      const existing = pending.find((p) => p.key === key);
      if (existing) {
        existing.task = task;
        return;
      }
      pending.push({ key, task });
      pump();
    },
    cancel(key) {
      pending = pending.filter((p) => p.key !== key);
    },
    clear() {
      pending = [];
    },
    isQueued(key) {
      return pending.some((p) => p.key === key);
    },
    get inFlight() {
      return running.size;
    },
    get peak() {
      return peak;
    },
  };
}
