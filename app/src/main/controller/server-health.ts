import type { ServerHealthState } from '../store/state';

/**
 * Server health per (account, server) — spec §6.8:
 *
 * - `lastOk`: the server was last confirmed online for this account. Orders candidates
 *   ("best = most recent lastOk, then pool order"). Persisted.
 * - `refused until`: the server refused this account (an HMA server of another tenant,
 *   a ZoogVPN server outside the plan). 7 days. Persisted.
 * - `dead until`: handshake timeout, `/delay` 503/504, or the host vanished from DNS.
 *   2 h. In memory only — a connectivity hint, not durable state.
 *
 * Keys are the raw pool tokens of `Target.servers` (an IP literal or a hostname), so a
 * server refused for one account stays usable for another. Provider-agnostic: what
 * counts as "refused" or "dead" is decided by the caller (port-manager).
 */

export const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEAD_TTL_MS = 2 * 60 * 60 * 1000;

export interface ServerHealth {
  /** Confirmed online: records `lastOk` and clears any refused/dead mark for the pair. */
  markOk(accountId: string, server: string): void;
  markRefused(accountId: string, server: string): void;
  markDead(accountId: string, server: string): void;
  isRefused(accountId: string, server: string): boolean;
  isDead(accountId: string, server: string): boolean;
  /** Neither refused nor dead for this account. */
  isUsable(accountId: string, server: string): boolean;
  lastOk(accountId: string, server: string): number | undefined;
  /** The account was confirmed online on some server other than `exceptServer` within
   * the last `withinMs` — evidence that its credentials work. */
  workedRecently(accountId: string, withinMs: number, exceptServer?: string): boolean;
  /** Drops every refused/dead mark of the account (its credentials changed, so marks
   * earned under the old ones prove nothing). `lastOk` is kept. */
  forgetMarks(accountId: string): void;
  /** The persisted half (refused + lastOk), for `AppState.serverHealth`. */
  serialize(): ServerHealthState;
}

export interface ServerHealthOptions {
  /** @default Date.now */
  now?: () => number;
  /** Seeds the persisted half, e.g. `AppState.serverHealth` at startup. */
  initial?: ServerHealthState;
  /** @default REFUSED_TTL_MS (7 days) */
  refusedTtlMs?: number;
  /** @default DEAD_TTL_MS (2 h) */
  deadTtlMs?: number;
}

type PairMap = Map<string, Map<string, number>>;

function toMap(src: Record<string, Record<string, number>> | undefined): PairMap {
  const out: PairMap = new Map();
  for (const [accountId, servers] of Object.entries(src ?? {})) out.set(accountId, new Map(Object.entries(servers)));
  return out;
}

function toRecord(src: PairMap): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [accountId, servers] of src) if (servers.size > 0) out[accountId] = Object.fromEntries(servers);
  return out;
}

export function createServerHealth(opts: ServerHealthOptions = {}): ServerHealth {
  const now = opts.now ?? Date.now;
  const refusedTtlMs = opts.refusedTtlMs ?? REFUSED_TTL_MS;
  const deadTtlMs = opts.deadTtlMs ?? DEAD_TTL_MS;
  /** accountId -> server -> epoch ms the mark expires. */
  const refusedUntil = toMap(opts.initial?.refused);
  const deadUntil: PairMap = new Map();
  /** accountId -> server -> epoch ms last confirmed online. */
  const okAt = toMap(opts.initial?.lastOk);

  function set(map: PairMap, accountId: string, server: string, value: number): void {
    const m = map.get(accountId) ?? new Map<string, number>();
    m.set(server, value);
    map.set(accountId, m);
  }

  /** True while the (account, server) mark is in its window; drops it once elapsed. */
  function active(map: PairMap, accountId: string, server: string): boolean {
    const m = map.get(accountId);
    const until = m?.get(server);
    if (until === undefined) return false;
    if (until <= now()) {
      m!.delete(server);
      return false;
    }
    return true;
  }

  function serialize(): ServerHealthState {
    // Prune expired refusals so the persisted file does not grow forever.
    for (const [accountId, m] of refusedUntil) for (const server of [...m.keys()]) active(refusedUntil, accountId, server);
    return { refused: toRecord(refusedUntil), lastOk: toRecord(okAt) };
  }

  return {
    markOk(accountId, server) {
      set(okAt, accountId, server, now());
      refusedUntil.get(accountId)?.delete(server);
      deadUntil.get(accountId)?.delete(server);
    },
    markRefused: (accountId, server) => set(refusedUntil, accountId, server, now() + refusedTtlMs),
    markDead: (accountId, server) => set(deadUntil, accountId, server, now() + deadTtlMs),
    isRefused: (accountId, server) => active(refusedUntil, accountId, server),
    isDead: (accountId, server) => active(deadUntil, accountId, server),
    isUsable: (accountId, server) => !active(refusedUntil, accountId, server) && !active(deadUntil, accountId, server),
    lastOk: (accountId, server) => okAt.get(accountId)?.get(server),
    workedRecently(accountId, withinMs, exceptServer) {
      const since = now() - withinMs;
      for (const [server, at] of okAt.get(accountId) ?? []) if (server !== exceptServer && at > since) return true;
      return false;
    },
    forgetMarks(accountId) {
      refusedUntil.delete(accountId);
      deadUntil.delete(accountId);
    },
    serialize,
  };
}
