/**
 * Per-server-IP health memory for the controller's bad-IP failover (spec §6.4:
 * "Bad server IP remembered for 2 h; fail over to another IP of the same location",
 * and §5.1's catalog "best first by lastOk").
 *
 * Deliberately in-memory and process-local by default: the 2 h bad window is a
 * short-lived connectivity hint, not durable state, and `lastOk` recency only needs
 * to outlive a few retries within a session to order failover candidates. The real
 * `Engine`/`port-manager` own one shared instance; it is injectable so a test can
 * drive it with a fake clock and so the bootstrap layer can, if it wants catalog-level
 * persistence (HMA `ips[].lastOk` surviving a restart), supply its own implementation
 * that also writes through to the on-disk catalog — nothing here assumes otherwise.
 *
 * Keys are the raw server token `port-manager` selects from `Target.servers` — an IP
 * literal for HMA/ZoogVPN, or a hostname for Surfshark (whose single candidate is a
 * hostname re-resolved on every start). Marking a single-candidate hostname bad is a
 * harmless no-op for failover (there is nothing else to pick), which is exactly §5.3's
 * "re-resolve the one host" behaviour.
 */

/** How long a server IP is remembered as bad before it is eligible again (spec §6.4). */
export const DEFAULT_BAD_TTL_MS = 2 * 60 * 60 * 1000;

export interface ServerMemory {
  /** Marks `server` as bad from now, for the configured TTL. */
  markBad(server: string): void;
  /** True while `server` is still within its bad window. */
  isBad(server: string): boolean;
  /** Records that `server` was just confirmed working (clears any bad mark). */
  markOk(server: string): void;
  /** Epoch ms of the last `markOk` for `server`, or `undefined` if never confirmed. */
  lastOk(server: string): number | undefined;
}

export interface ServerMemoryOptions {
  /** @default Date.now */
  now?: () => number;
  /** @default DEFAULT_BAD_TTL_MS (2 h, spec §6.4) */
  badTtlMs?: number;
}

export function createServerMemory(opts: ServerMemoryOptions = {}): ServerMemory {
  const now = opts.now ?? Date.now;
  const badTtlMs = opts.badTtlMs ?? DEFAULT_BAD_TTL_MS;
  /** server -> epoch ms the bad window expires. */
  const badUntil = new Map<string, number>();
  /** server -> epoch ms of its last confirmed success. */
  const okAt = new Map<string, number>();

  return {
    markBad(server) {
      badUntil.set(server, now() + badTtlMs);
    },
    isBad(server) {
      const until = badUntil.get(server);
      if (until === undefined) return false;
      if (until <= now()) {
        badUntil.delete(server); // window elapsed — stop carrying it
        return false;
      }
      return true;
    },
    markOk(server) {
      okAt.set(server, now());
      badUntil.delete(server);
    },
    lastOk(server) {
      return okAt.get(server);
    },
  };
}
