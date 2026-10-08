import { isIP } from 'node:net';
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
 * A mark belongs to the MACHINE, not to the name it was reached by: it is keyed by the
 * server's resolved IP once known (`noteIp`), so every token resolving to that IP shares
 * it (✅ `de7.webunlim.com` and `fr4.webunlim.com` are one machine, 185.177.229.121:
 * once de7 refused the account, fr4 is skipped without another handshake). A token whose
 * IP is not known yet is keyed by the token itself; such a mark is moved onto the IP the
 * first time the token resolves (which also migrates marks persisted before this change,
 * when every mark was keyed by token). The token → IP map is persisted with the marks,
 * so they still apply right after a restart, before anything has been resolved.
 *
 * Marks are per account, so a server refused for one account stays usable for another.
 * Provider-agnostic: what counts as "refused" or "dead" is decided by the caller.
 */

export const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEAD_TTL_MS = 2 * 60 * 60 * 1000;

export interface ServerHealth {
  /** `server` (a hostname) resolved to `ip`: from now on its marks are the IP's, shared
   * with every other token on that IP. True when this changed the known IP (the caller
   * may want to persist). */
  noteIp(server: string, ip: string): boolean;
  /** The last IP `server` resolved to (the server itself for an IP literal), if known. */
  ipOf(server: string): string | undefined;
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
  /** Drops the account's refused marks set at or after `sinceMs`: they were made on an
   * assumption that turned out false (that its credentials work). */
  forgetRefusalsSince(accountId: string, sinceMs: number): void;
  /** The persisted half (refused + lastOk + the token → IP map), for `AppState.serverHealth`. */
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

/** Moves every account's `token`-keyed value onto `ip`, keeping the later one if both exist. */
function migrate(map: PairMap, token: string, ip: string): void {
  for (const m of map.values()) {
    const v = m.get(token);
    if (v === undefined) continue;
    m.delete(token);
    m.set(ip, Math.max(v, m.get(ip) ?? v));
  }
}

export function createServerHealth(opts: ServerHealthOptions = {}): ServerHealth {
  const now = opts.now ?? Date.now;
  const refusedTtlMs = opts.refusedTtlMs ?? REFUSED_TTL_MS;
  const deadTtlMs = opts.deadTtlMs ?? DEAD_TTL_MS;
  /** accountId -> server key -> epoch ms the mark expires. */
  const refusedUntil = toMap(opts.initial?.refused);
  const deadUntil: PairMap = new Map();
  /** accountId -> server key -> epoch ms last confirmed online. */
  const okAt = toMap(opts.initial?.lastOk);
  /** hostname -> its last resolved IP. */
  const ips = new Map<string, string>(Object.entries(opts.initial?.ips ?? {}).filter(([token, ip]) => !isIP(token) && isIP(ip)));
  for (const [token, ip] of ips) {
    migrate(refusedUntil, token, ip);
    migrate(okAt, token, ip);
  }

  /** The key a server's marks live under: its IP when known, else the token. */
  function keyOf(server: string): string {
    return isIP(server) ? server : (ips.get(server) ?? server);
  }

  function set(map: PairMap, accountId: string, server: string, value: number): void {
    const m = map.get(accountId) ?? new Map<string, number>();
    m.set(keyOf(server), value);
    map.set(accountId, m);
  }

  /** True while the mark under `key` is in its window; drops it once elapsed. */
  function activeAt(map: PairMap, accountId: string, key: string): boolean {
    const m = map.get(accountId);
    const until = m?.get(key);
    if (until === undefined) return false;
    if (until <= now()) {
      m!.delete(key);
      return false;
    }
    return true;
  }

  function active(map: PairMap, accountId: string, server: string): boolean {
    return activeAt(map, accountId, keyOf(server));
  }

  function clear(map: PairMap, accountId: string, server: string): void {
    map.get(accountId)?.delete(keyOf(server));
  }

  function serialize(): ServerHealthState {
    // Prune expired refusals so the persisted file does not grow forever.
    for (const [accountId, m] of refusedUntil) for (const key of [...m.keys()]) activeAt(refusedUntil, accountId, key);
    return {
      refused: toRecord(refusedUntil),
      lastOk: toRecord(okAt),
      ...(ips.size > 0 ? { ips: Object.fromEntries(ips) } : {}),
    };
  }

  return {
    noteIp(server, ip) {
      if (isIP(server) || !isIP(ip) || ips.get(server) === ip) return false;
      ips.set(server, ip);
      // Marks still under the token (made before it ever resolved, or persisted by an
      // older version) move onto the machine.
      migrate(refusedUntil, server, ip);
      migrate(deadUntil, server, ip);
      migrate(okAt, server, ip);
      return true;
    },
    ipOf: (server) => (isIP(server) ? server : ips.get(server)),
    markOk(accountId, server) {
      set(okAt, accountId, server, now());
      clear(refusedUntil, accountId, server);
      clear(deadUntil, accountId, server);
    },
    markRefused: (accountId, server) => set(refusedUntil, accountId, server, now() + refusedTtlMs),
    markDead: (accountId, server) => set(deadUntil, accountId, server, now() + deadTtlMs),
    isRefused: (accountId, server) => active(refusedUntil, accountId, server),
    isDead: (accountId, server) => active(deadUntil, accountId, server),
    isUsable: (accountId, server) => !active(refusedUntil, accountId, server) && !active(deadUntil, accountId, server),
    lastOk: (accountId, server) => okAt.get(accountId)?.get(keyOf(server)),
    workedRecently(accountId, withinMs, exceptServer) {
      const since = now() - withinMs;
      const except = exceptServer === undefined ? undefined : keyOf(exceptServer);
      for (const [key, at] of okAt.get(accountId) ?? []) if (key !== except && at > since) return true;
      return false;
    },
    forgetMarks(accountId) {
      refusedUntil.delete(accountId);
      deadUntil.delete(accountId);
    },
    forgetRefusalsSince(accountId, sinceMs) {
      const m = refusedUntil.get(accountId);
      if (!m) return;
      for (const [key, until] of [...m]) if (until - refusedTtlMs >= sinceMs) m.delete(key);
    },
    serialize,
  };
}
