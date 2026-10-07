/**
 * ZoogVPN plan-refusal vs wrong-password heuristic (spec §5.2; mirrors v1 farm.py
 * `refused_by` / `note_refusal`). Over OpenVPN both arrive as a plain auth failure, so:
 *
 *  - an auth failure on one server while another server on the same account is online
 *    → 'not-in-plan' for that (account, server) pair, cached for 7 days;
 *  - auth failures on ≥ 3 distinct servers for the account, with none online
 *    → 'bad-login' for the whole account;
 *  - otherwise (not enough evidence yet) → 'undecided'. Callers keep retrying on the
 *    normal back-off until one of the two decisive verdicts is reached.
 *
 * The tracker owns its own in-memory bookkeeping (failures + "seen online" markers) so
 * `classifyAuthFailure` needs only the account id. Wire it up by calling `recordOnline`
 * whenever a port for this account reaches `online`, and `recordAuthFailure` whenever a
 * port fails with `reason: 'auth'`.
 */

export type RefusalVerdict = 'not-in-plan' | 'bad-login' | 'undecided';

export const REFUSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_SERVER_THRESHOLD = 3;

export interface RefusalTracker {
  recordAuthFailure(accountId: string, serverKey: string): void;
  /** A server is known to be working for this account right now. */
  recordOnline(accountId: string, serverKey: string): void;
  classifyAuthFailure(accountId: string): RefusalVerdict;
  /** Is this specific (account, server) pair currently remembered as refused? */
  isRefused(accountId: string, serverKey: string): boolean;
}

export interface CreateRefusalTrackerOptions {
  /** Injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
}

export function createRefusalTracker(options: CreateRefusalTrackerOptions = {}): RefusalTracker {
  const clock = options.clock ?? Date.now;
  // accountId -> serverKey -> epoch ms of the failure
  const failures = new Map<string, Map<string, number>>();
  // accountId -> serverKey -> true (presence = last known state was "online")
  const online = new Map<string, Set<string>>();

  function activeFailures(accountId: string): Map<string, number> {
    const m = failures.get(accountId);
    if (!m) return new Map();
    const now = clock();
    const live = new Map<string, number>();
    for (const [server, at] of m) {
      if (now - at < REFUSAL_TTL_MS) live.set(server, at);
    }
    // prune expired entries so memory doesn't grow unbounded
    if (live.size !== m.size) failures.set(accountId, live);
    return live;
  }

  return {
    recordAuthFailure(accountId, serverKey) {
      const m = failures.get(accountId) ?? new Map<string, number>();
      m.set(serverKey, clock());
      failures.set(accountId, m);
      online.get(accountId)?.delete(serverKey);
    },

    recordOnline(accountId, serverKey) {
      const s = online.get(accountId) ?? new Set<string>();
      s.add(serverKey);
      online.set(accountId, s);
      // a server that now works clears its own refusal memory (v1 parity)
      failures.get(accountId)?.delete(serverKey);
    },

    classifyAuthFailure(accountId) {
      const hasOnline = (online.get(accountId)?.size ?? 0) > 0;
      if (hasOnline) return 'not-in-plan';
      if (activeFailures(accountId).size >= AUTH_SERVER_THRESHOLD) return 'bad-login';
      return 'undecided';
    },

    isRefused(accountId, serverKey) {
      return activeFailures(accountId).has(serverKey);
    },
  };
}
