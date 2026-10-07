import type { RefusalsState } from '../store/state';

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
 * whenever a port for this account reaches `online`, `clearOnline` whenever it stops or
 * fails, and `recordAuthFailure` whenever a port fails with `reason: 'auth'`. Call
 * `serialize()` after every mutation and persist the result into `AppState.refusals` (and
 * pass it back in as `initial` next time) so the memory survives an app restart.
 */

export type RefusalVerdict = 'not-in-plan' | 'bad-login' | 'undecided';

export const REFUSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** An "online" marker older than this no longer counts as live evidence — it is cleared
 * explicitly on stop/fail (reviewer item 9), but this TTL is the safety net for a marker
 * that was never explicitly cleared (e.g. the app was killed). */
export const ONLINE_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_SERVER_THRESHOLD = 3;

export interface RefusalTracker {
  recordAuthFailure(accountId: string, serverKey: string): void;
  /** A server is known to be working for this account right now. */
  recordOnline(accountId: string, serverKey: string): void;
  /** The port for this (account, server) stopped or failed: it is no longer evidence
   * that the account works, so stop counting it as "online". */
  clearOnline(accountId: string, serverKey: string): void;
  classifyAuthFailure(accountId: string): RefusalVerdict;
  /** Is this specific (account, server) pair currently remembered as refused? */
  isRefused(accountId: string, serverKey: string): boolean;
  /** A snapshot suitable for `AppState.refusals` (store/state.ts). */
  serialize(): RefusalsState;
}

export interface CreateRefusalTrackerOptions {
  /** Injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Seeds the tracker from a persisted snapshot (e.g. `AppState.refusals` at startup),
   * so the memory survives an app restart. */
  initial?: RefusalsState;
}

function toNestedMap(src: Record<string, Record<string, number>> | undefined): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [accountId, servers] of Object.entries(src ?? {})) {
    out.set(accountId, new Map(Object.entries(servers)));
  }
  return out;
}

function toPlainObject(src: Map<string, Map<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [accountId, servers] of src) {
    out[accountId] = Object.fromEntries(servers);
  }
  return out;
}

export function createRefusalTracker(options: CreateRefusalTrackerOptions = {}): RefusalTracker {
  const clock = options.clock ?? Date.now;
  // accountId -> serverKey -> epoch ms of the failure
  const failures = toNestedMap(options.initial?.failures);
  // accountId -> serverKey -> epoch ms last seen online
  const online = toNestedMap(options.initial?.online);

  function liveEntries(store: Map<string, Map<string, number>>, accountId: string, ttlMs: number): Map<string, number> {
    const m = store.get(accountId);
    if (!m) return new Map();
    const now = clock();
    const live = new Map<string, number>();
    for (const [server, at] of m) {
      if (now - at < ttlMs) live.set(server, at);
    }
    // prune expired entries so memory doesn't grow unbounded
    if (live.size !== m.size) store.set(accountId, live);
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
      const s = online.get(accountId) ?? new Map<string, number>();
      s.set(serverKey, clock());
      online.set(accountId, s);
      // a server that now works clears its own refusal memory (v1 parity)
      failures.get(accountId)?.delete(serverKey);
    },

    clearOnline(accountId, serverKey) {
      online.get(accountId)?.delete(serverKey);
    },

    classifyAuthFailure(accountId) {
      const hasOnline = liveEntries(online, accountId, ONLINE_TTL_MS).size > 0;
      if (hasOnline) return 'not-in-plan';
      if (liveEntries(failures, accountId, REFUSAL_TTL_MS).size >= AUTH_SERVER_THRESHOLD) return 'bad-login';
      return 'undecided';
    },

    isRefused(accountId, serverKey) {
      return liveEntries(failures, accountId, REFUSAL_TTL_MS).has(serverKey);
    },

    serialize() {
      return { failures: toPlainObject(failures), online: toPlainObject(online) };
    },
  };
}
