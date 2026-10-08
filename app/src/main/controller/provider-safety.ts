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

/** Attempts with no handshake in a row before a never-proven WireGuard key is stopped. */
export const WG_UNPROVEN_FAILURE_LIMIT = 3;

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

export interface WgKeyGuard {
  /** The account's key completed a handshake: it is proven, and its count resets. */
  recordHandshake(accountId: string): void;
  /**
   * One attempt ended without a handshake. `proven` = the account has handshaken
   * before (persisted `lastOk`), in which case only the normal back-off applies.
   * Returns true when this failure locks the account.
   */
  recordNoHandshake(accountId: string, proven: boolean): boolean;
  isLocked(accountId: string): boolean;
  /** A user action (Start, Change IP) lifts the lock for ONE more attempt: if that one
   * fails without a handshake too, the account is locked again at once. */
  rearm(accountId: string): void;
  /** New credentials: drop the lock and the count. */
  forget(accountId: string): void;
  /** accountId -> epoch ms it was locked, for `AppState.wgLockouts`. */
  serialize(): Record<string, number>;
}

/**
 * Stops a WireGuard key that has never been seen to work from being retried forever.
 * Counts attempts with no handshake per account; after `limit` in a row the account is
 * locked: no automatic attempt at all until the user acts. The lock is persisted, so an
 * app restart does not start the count over.
 */
export function createWgKeyGuard(opts: { now?: () => number; initial?: Record<string, number>; limit?: number } = {}): WgKeyGuard {
  const now = opts.now ?? Date.now;
  const limit = opts.limit ?? WG_UNPROVEN_FAILURE_LIMIT;
  const lockedAt = new Map(Object.entries(opts.initial ?? {}));
  const failures = new Map<string, number>();
  return {
    recordHandshake(accountId) {
      failures.delete(accountId);
      lockedAt.delete(accountId);
    },
    recordNoHandshake(accountId, proven) {
      if (proven || lockedAt.has(accountId)) return false;
      const n = (failures.get(accountId) ?? 0) + 1;
      failures.set(accountId, n);
      if (n < limit) return false;
      lockedAt.set(accountId, now());
      return true;
    },
    isLocked: (accountId) => lockedAt.has(accountId),
    rearm(accountId) {
      if (!lockedAt.delete(accountId)) return;
      failures.set(accountId, limit - 1);
    },
    forget(accountId) {
      lockedAt.delete(accountId);
      failures.delete(accountId);
    },
    serialize: () => Object.fromEntries(lockedAt),
  };
}
