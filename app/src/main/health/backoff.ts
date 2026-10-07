const BASE_MS = 30_000; // 30s
const MAX_MS = 30 * 60_000; // 30min
const JITTER_RATIO = 0.2; // ±20%

/**
 * Retry back-off schedule (spec §6.4): 30s, 1, 2, 4min … capped at 30min,
 * plus random jitter. `rng` is injectable (defaults to `Math.random`) so
 * tests can make it deterministic.
 */
export function nextBackoffMs(attempt: number, rng: () => number = Math.random): number {
  const clampedAttempt = Math.max(0, attempt);
  const raw = BASE_MS * 2 ** clampedAttempt;
  const capped = Math.min(raw, MAX_MS);
  const jitterSpan = capped * JITTER_RATIO;
  const jitter = (rng() * 2 - 1) * jitterSpan; // uniform in [-jitterSpan, +jitterSpan]
  return Math.max(0, Math.round(capped + jitter));
}
