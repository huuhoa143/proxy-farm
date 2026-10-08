/**
 * Surfshark server pools (spec §5.3, §6.8): the IPs behind each cluster
 * hostname, discovered in the app by DNS sampling and persisted per cluster.
 *
 * A cluster hostname (`jp-tok.prod.surfshark.com`) is DNS round-robin over a
 * pool of 20+ servers; each answer names two of them and lives a few seconds.
 * The cluster's single WireGuard pubKey works for every pool IP, so pinning
 * one gives a port a fixed exit (server IP + 1). Discovery therefore samples
 * the hostname several times, a few seconds apart, through the system
 * resolver and DoH (`cloudflare-dns.com`, a different view of the rotation),
 * and accumulates every A record seen with `firstSeen` / `lastSeen`.
 *
 * Schedule:
 * - A cluster is sampled when it has never been sampled, and again at most
 *   every 12 h (`POOL_REFRESH_MS`); each refresh adds to the pool, so it
 *   grows past what a single session sees.
 * - A cluster with no IPs at all gets one awaited round first (at most 4 s
 *   for all of them), so a fresh install can place several ports at once
 *   (a round already yields 3–4 IPs); the remaining rounds, and every
 *   refresh of a known pool, run in the background.
 * - A failed discovery is retried after 15 min, not on every `targets()`.
 * - Pruning happens only after a successful sample: an IP not seen for 7 days
 *   (`POOL_FORGET_MS`) is dropped. So an app left closed for a week keeps its
 *   pool until it has looked again. The spec's "and not OK in that time"
 *   needs per-server health, which the controller owns: a pinned server that
 *   still works but left DNS for 7 days leaves the pool and its port moves.
 *
 * Every cluster of the list is kept fresh, not only the ones in use:
 * `targets()` cannot tell which locations hold ports, and the cost is small
 * (about 180 clusters × 6 rounds × 2 resolvers every 12 h, 8 clusters at a
 * time).
 *
 * Network access is injectable (`PoolNet`) so tests stay hermetic.
 */
import { promises as dns } from 'node:dns';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const POOL_REFRESH_MS = 12 * 60 * 60 * 1000;
export const POOL_FORGET_MS = 7 * 24 * 60 * 60 * 1000;
export const POOL_RETRY_MS = 15 * 60 * 1000;
export const DOH_URL = 'https://cloudflare-dns.com/dns-query';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LOOKUP_TIMEOUT_MS = 5000;

export interface PoolNet {
  /** A records via the OS resolver. */
  resolveSystem(host: string): Promise<string[]>;
  /** A records via DNS-over-HTTPS. */
  resolveDoh(host: string): Promise<string[]>;
  sleep(ms: number): Promise<void>;
}

export interface PoolIp {
  ip: string;
  firstSeen: number; // epoch ms
  lastSeen: number; // epoch ms
}

interface PoolEntry {
  /** Last completed sampling run (epoch ms); 0 = only a first round so far. */
  sampledAt: number;
  ips: PoolIp[];
}

interface PoolFile {
  version: 1;
  clusters: Record<string, PoolEntry>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export const defaultPoolNet: PoolNet = {
  async resolveSystem(host) {
    const addrs = await withTimeout(dns.lookup(host, { all: true, family: 4 }), LOOKUP_TIMEOUT_MS, host);
    return addrs.map((a) => a.address);
  },
  async resolveDoh(host) {
    const url = `${DOH_URL}?name=${encodeURIComponent(host)}&type=A`;
    const res = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DoH ${host}: HTTP ${res.status}`);
    const body = (await res.json()) as { Answer?: Array<{ type?: number; data?: unknown }> };
    return (body.Answer ?? []).filter((a) => a.type === 1 && typeof a.data === 'string').map((a) => a.data as string);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface SurfsharkPoolsOptions {
  poolPath: string;
  net?: PoolNet;
  now?: () => number;
  /** Lookups per sampling run (each through both resolvers). */
  rounds?: number;
  /** Pause between rounds; answers rotate every few seconds. */
  gapMs?: number;
  /** Clusters sampled at once. */
  concurrency?: number;
  /** Longest `ensure()` waits for first rounds. */
  firstRoundBudgetMs?: number;
}

export interface SurfsharkPools {
  /** Pool IPs of a cluster, best first: seen in the last day, then oldest known. Sync, from memory. */
  servers(hostname: string): string[];
  /**
   * Starts discovery for the clusters that are due. Resolves once every
   * cluster without any IP has had its first round; the rest continues in
   * the background (see `idle`). Never rejects.
   */
  ensure(hostnames: string[]): Promise<void>;
  /** Resolves when no background sampling is running (tests, shutdown). */
  idle(): Promise<void>;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export function createSurfsharkPools(opts: SurfsharkPoolsOptions): SurfsharkPools {
  const net = opts.net ?? defaultPoolNet;
  const now = opts.now ?? Date.now;
  const rounds = opts.rounds ?? 6;
  const gapMs = opts.gapMs ?? 2000;
  const concurrency = opts.concurrency ?? 8;
  const firstRoundBudgetMs = opts.firstRoundBudgetMs ?? 4000;

  let file: PoolFile = { version: 1, clusters: {} };
  let loaded: Promise<void> | undefined;
  const running = new Set<string>();
  const failedAt = new Map<string, number>();
  let background: Promise<void> = Promise.resolve();
  let writing: Promise<void> = Promise.resolve();

  function load(): Promise<void> {
    loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(opts.poolPath, 'utf8')) as PoolFile;
        if (parsed?.version === 1 && parsed.clusters && typeof parsed.clusters === 'object') file = parsed;
      } catch {
        // No pool yet, or unreadable: start empty; discovery rebuilds it.
      }
    })();
    return loaded;
  }

  function persist(): Promise<void> {
    // Serialised, and atomic via rename, so concurrent cluster completions
    // never interleave and a crash never leaves half a file.
    writing = writing.then(async () => {
      try {
        await mkdir(path.dirname(opts.poolPath), { recursive: true });
        const tmp = `${opts.poolPath}.tmp`;
        await writeFile(tmp, JSON.stringify(file), 'utf8');
        await rename(tmp, opts.poolPath);
      } catch {
        // Losing a write only costs re-sampling later.
      }
    });
    return writing;
  }

  /** One lookup through both resolvers; undefined if both failed. */
  async function sampleOnce(host: string): Promise<string[] | undefined> {
    const results = await Promise.allSettled([net.resolveSystem(host), net.resolveDoh(host)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled');
    if (ok.length === 0) return undefined;
    return [...new Set(ok.flatMap((r) => r.value).filter((ip) => IPV4_RE.test(ip)))];
  }

  function record(host: string, ips: string[], at: number): void {
    const entry = (file.clusters[host] ??= { sampledAt: 0, ips: [] });
    for (const ip of ips) {
      const known = entry.ips.find((p) => p.ip === ip);
      if (known) known.lastSeen = Math.max(known.lastSeen, at);
      else entry.ips.push({ ip, firstSeen: at, lastSeen: at });
    }
  }

  /** `count` rounds for one cluster; marks it sampled (and prunes) if any round succeeded. */
  async function sample(host: string, count: number, leadingGap: boolean): Promise<boolean> {
    let succeeded = false;
    for (let i = 0; i < count; i++) {
      if (i > 0 || leadingGap) await net.sleep(gapMs);
      const ips = await sampleOnce(host);
      if (!ips) continue;
      succeeded = true;
      record(host, ips, now());
    }
    return succeeded;
  }

  function isDue(host: string, at: number): boolean {
    if (running.has(host)) return false;
    const failed = failedAt.get(host);
    if (failed !== undefined && at - failed < POOL_RETRY_MS) return false;
    const entry = file.clusters[host];
    return !entry || entry.ips.length === 0 || at - entry.sampledAt >= POOL_REFRESH_MS;
  }

  async function runBackground(jobs: Array<{ host: string; firstDone: boolean }>): Promise<void> {
    await mapLimit(jobs, concurrency, async ({ host, firstDone }) => {
      try {
        const ok = (await sample(host, firstDone ? rounds - 1 : rounds, firstDone)) || firstDone;
        if (ok) {
          const at = now();
          const entry = file.clusters[host];
          if (entry) {
            entry.sampledAt = at;
            entry.ips = entry.ips.filter((p) => at - p.lastSeen < POOL_FORGET_MS);
          }
          failedAt.delete(host);
        } else {
          failedAt.set(host, now());
        }
        await persist();
      } finally {
        running.delete(host);
      }
    });
  }

  return {
    servers(hostname) {
      const ips = file.clusters[hostname]?.ips ?? [];
      const newest = Math.max(0, ...ips.map((p) => p.lastSeen));
      const recent = (p: PoolIp) => (newest - p.lastSeen < 24 * 60 * 60 * 1000 ? 0 : 1);
      return [...ips]
        .sort((a, b) => recent(a) - recent(b) || a.firstSeen - b.firstSeen || (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0))
        .map((p) => p.ip);
    },

    async ensure(hostnames) {
      await load();
      const at = now();
      const due = [...new Set(hostnames)].filter((h) => isDue(h, at));
      if (due.length === 0) return;
      for (const h of due) running.add(h);

      // Clusters with no IP yet: one round now, so the caller gets a usable pool.
      // Bounded by a budget so a black-holed network can't stall the caller;
      // a cluster whose first round misses it just gets all its rounds later.
      const empty = due.filter((h) => !file.clusters[h]?.ips.length);
      const firstDone = new Set<string>();
      const firstRound = mapLimit(empty, Math.max(concurrency, 32), async (h) => {
        const ips = await sampleOnce(h);
        if (ips?.length) {
          record(h, ips, now());
          firstDone.add(h);
        }
      });
      let budget: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([firstRound, new Promise<void>((r) => (budget = setTimeout(r, firstRoundBudgetMs)))]);
      clearTimeout(budget);
      if (firstDone.size > 0) void persist();

      const jobs = due.map((host) => ({ host, firstDone: firstDone.has(host) }));
      const prev = background;
      background = prev.then(() => runBackground(jobs)).catch(() => undefined);
    },

    idle() {
      return background.then(() => writing);
    },
  };
}
