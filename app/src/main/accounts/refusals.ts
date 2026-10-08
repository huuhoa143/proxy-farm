import type { RefusalsState } from '../store/state';

/**
 * Auth-failure evidence per (account, server), for the ONE case the live credential
 * check cannot decide (spec §5.2).
 *
 * Over OpenVPN a ZoogVPN wrong password and a server outside the plan both arrive as
 * `AUTH_FAILED`. 0.1.0 guessed from counts ("3 distinct servers refused, none online →
 * bad login"), which told a fresh account on a restrictive plan that its password was
 * wrong. The controller now asks a free-tier server instead (controller/credential-probe.ts),
 * which answers deterministically. This tracker is only the last resort for when every
 * free-tier server is unreachable: `suspectsBadLogin` then stops the pool walk, and the
 * port says the login could NOT be verified — never that the password is wrong.
 *
 * Wire-up: `recordAuthFailure` on a port's auth failure, `recordOnline` when a port of
 * the account reaches `online`, `clearOnline` when it stops or fails. Persist
 * `serialize()` into `AppState.refusals` and pass it back as `initial`.
 */

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
  /** Last resort only (see the module docs): refused on ≥ 3 distinct servers with none
   * online. Means "the login could not be verified", not "the password is wrong". */
  suspectsBadLogin(accountId: string): boolean;
  /** Is this specific (account, server) pair currently remembered as refused? */
  isRefused(accountId: string, serverKey: string): boolean;
  /** The account's credentials changed: auth failures seen under the old ones are no
   * evidence any more. "Seen online" markers are kept. */
  forgetFailures(accountId: string): void;
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

    suspectsBadLogin(accountId) {
      if (liveEntries(online, accountId, ONLINE_TTL_MS).size > 0) return false;
      return liveEntries(failures, accountId, REFUSAL_TTL_MS).size >= AUTH_SERVER_THRESHOLD;
    },

    isRefused(accountId, serverKey) {
      return liveEntries(failures, accountId, REFUSAL_TTL_MS).has(serverKey);
    },

    forgetFailures(accountId) {
      failures.delete(accountId);
    },

    serialize() {
      return { failures: toPlainObject(failures), online: toPlainObject(online) };
    },
  };
}
