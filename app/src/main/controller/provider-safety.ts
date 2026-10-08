/**
 * Provider-safety limits on how often the app may knock on a provider's door (spec §6.4
 * "Provider safety"). They exist because of the 2026-10-08 incident: a Surfshark
 * account's VPN access was suspended after the app sent mass WireGuard handshakes that
 * never completed (same failure mode as gluetun issue #2595). WireGuard is silent — a
 * rejected key looks exactly like an unreachable server — so nothing else in the health
 * machine could tell "keep trying" from "stop now".
 */

/** Handshake attempts one account may start per minute, across all of its ports. */
export const ATTEMPTS_PER_MINUTE = 6;

export interface AttemptLimiter {
  /**
   * Takes one attempt from `accountId`'s budget. Returns 0 when the attempt may start
   * now (and consumes it), else how many ms to wait before asking again (nothing is
   * consumed).
   */
  take(accountId: string): number;
}

/**
 * A token bucket per account: `perMinute` tokens refill evenly over a minute, and at
 * most `perMinute` can be saved up, so a burst (app start, "Start all") gets that many
 * at once and then one every `60 / perMinute` s.
 */
export function createAttemptLimiter(opts: { now?: () => number; perMinute?: number } = {}): AttemptLimiter {
  const now = opts.now ?? Date.now;
  const capacity = opts.perMinute ?? ATTEMPTS_PER_MINUTE;
  const refillMs = 60_000 / capacity;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(accountId) {
      const t = now();
      const b = buckets.get(accountId) ?? { tokens: capacity, at: t };
      const tokens = Math.min(capacity, b.tokens + Math.max(0, t - b.at) / refillMs);
      if (tokens >= 1) {
        buckets.set(accountId, { tokens: tokens - 1, at: t });
        return 0;
      }
      buckets.set(accountId, { tokens, at: t });
      return Math.ceil((1 - tokens) * refillMs);
    },
  };
}
