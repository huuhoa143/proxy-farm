import { lookup, resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  makePortKey,
  splitPortKey,
  type Account,
  type AccountSecret,
  type ExportFormat,
  type FailReason,
  type PortRow,
  type PortState,
  type ProviderId,
  type RenderInput,
  type RotateResult,
  type ServerInfo,
  type Target,
} from '../../shared/contracts';
import type { AccountPool } from '../accounts/pool';
import { createRefusalTracker, type RefusalTracker } from '../accounts/refusals';
import { createAutoRotateScheduler, type AutoRotateScheduler } from './auto-rotate';
import { nextBackoffMs } from '../health/backoff';
import type { SecretStore } from '../store/secrets';
import type { StateStore } from '../store/state';
import { exportLines, type ExportCreds } from './export-format';
import { PortInUseError, type Engine, type ExitIpProber, type PortAllocator, type ProviderRegistry } from './ports';
import { createServerHealth, type ServerHealth } from './server-health';

export interface PortManagerDeps {
  state: StateStore;
  secrets: SecretStore;
  engine: Engine;
  providers: ProviderRegistry;
  exitIp: ExitIpProber;
  allocator: PortAllocator;
  /** LAN IPv4 lookup for `exportPorts`'s LAN-sharing host (reviewer minor). Injectable
   * for tests; @default a real `os.networkInterfaces()` scan, falling back to
   * `127.0.0.1` if no external IPv4 interface is found. */
  getLanIPv4?: () => string;
  /**
   * ZoogVPN plan-refusal-vs-login tracker (spec §5.2), keyed by (account, server).
   * @default a fresh tracker seeded from `AppState.refusals` (so it survives an app
   * restart) — the same instance should also be handed to `accounts/pool.ts`'s
   * `createAccountPool` so both see the same memory.
   */
  refusals?: RefusalTracker;
  /** How long `rotatePort` waits for the restarted port to actually reach `online`
   * (verified by `PortHealth`, via `Engine.onStateChange`) before giving up on
   * confirming the new exit IP (reviewer item 1). @default 45_000 */
  rotateOnlineTimeoutMs?: number;
  /** Drives §4.2/§6.5's per-port auto-rotate timers; this module calls `.sync()` on it
   * itself after every mutation that can affect the desired timer set (reviewer item 8)
   * — the integrator should NOT also wire `auto-rotate.ts` separately once this is
   * supplied (or the default below is used). @default a fresh scheduler whose
   * `rotate(key)` calls this module's own `rotatePort`. */
  autoRotate?: AutoRotateScheduler;
  /** Schedules the local (pre-engine) retry timer behind a `retrying`/`failed` row's
   * countdown (reviewer item 7) — the ONE place port-manager itself (not `PortHealth`)
   * owns a row's retry because the engine was never engaged (no account/secret/target,
   * no free server, a pre-flight `port-in-use`, or an unexpected exception during
   * `startPort`/`rotatePort`). Injectable for tests. @default real `setTimeout`-based. */
  scheduleRetry?: (ms: number, cb: () => void) => () => void;
  /** Injectable for deterministic backoff-jitter tests. @default `Math.random`. */
  backoffRng?: () => number;
  /**
   * Turns a server token into an IPv4 literal before `provider.bind` (spec §6.1.4:
   * "server hostnames are resolved by the controller beforehand, so configs contain IPs
   * only"). Resolving on every (re)start also catches a host that vanished from DNS.
   * `fresh` asks for an answer straight from the DNS server rather than the OS cache:
   * set for a round-robin pool hostname (`Target.poolHostnames`), whose next answer may
   * name another server.
   * @default IP literals pass through, hostnames go through the OS resolver (IPv4 only);
   * `fresh` queries the configured DNS server (one random A record), falling back to it.
   */
  resolveServer?: (server: string, opts?: { fresh?: boolean }) => Promise<string>;
  /**
   * Per-(account, server) health behind the server-pool failover (spec §6.8). @default a
   * fresh instance seeded from `AppState.serverHealth`; the persisted half (refused,
   * lastOk) is written back there on every change.
   */
  serverHealth?: ServerHealth;
  /**
   * The account pool (spec §4.2 "move a port on refusal"): when every free server of a
   * location has refused the port's account, the port may move to another account of
   * the same provider that can still use one. Optional; without it the port just fails.
   */
  pool?: Pick<AccountPool, 'pickAccount'>;
}

export interface PortManager {
  startPort(key: string): Promise<void>;
  stopPort(key: string): Promise<void>;
  removePort(key: string): Promise<void>;
  /** Change IP (spec §6.5): to `toServer` when given, else the next free usable server. */
  rotatePort(key: string, toServer?: string): Promise<RotateResult>;
  /**
   * Adds one port to `target` for `accountId`, pinned to the best free usable server
   * (spec §6.8), with a restart-stable proxy port and the smallest free `#n`. The row is
   * created enabled (it counts toward the provider limit at once) and `queued`; the
   * caller starts it. `undefined` when no free usable server is left for that account,
   * or when `opts.atLimit()` says the provider's port limit is reached.
   * Calls are serialized, so two concurrent adds never pin the same server or port, and
   * `atLimit` is asked inside that lock, so they never overshoot the limit either.
   */
  addPort(target: Target, accountId: string, opts?: { atLimit?: () => boolean }): Promise<PortRow | undefined>;
  /** The location's pool with health, resolved IP (when known) and holder (spec §6.8).
   * Health is for `portKey`'s account when that port exists (its Change-IP menu), else
   * merged over the accounts the location's ports use. Synchronous: uses only
   * already-resolved IPs, never the network. */
  listServers(target: Target, portKey?: string): ServerInfo[];
  /** Servers of `target` that some account of its provider may use and no enabled port holds. */
  freeServerCount(target: Target): number;
  setAutoRotate(key: string, minutes: number): Promise<void>;
  exportPorts(keys: string[], format: ExportFormat): Promise<string>;
  testPort(key: string, speed: boolean): Promise<{ ok: boolean; exitIp?: string; latencyMs?: number; mbps?: number }>;
  /** Reconciles auto-rotate timers against the CURRENT `ports` (reviewer item 8). Called
   * internally after start/stop/remove/setAutoRotate/rotate already — exported mainly so
   * the integrator can call it once at app startup with the rows loaded from disk. */
  syncAutoRotate(): void;
  /** Cancels every auto-rotate timer. Call once on app shutdown so no rotate tick
   * fires (or keeps the event loop alive) while engines are being torn down. */
  stopAutoRotate(): void;
  /** The account's secret changed (HMA re-import, a re-entered password): forget the
   * refused/dead marks and auth-failure evidence gathered under the old credentials, so
   * no server stays shunned for days because of them. */
  credentialsChanged(accountId: string): void;
}

/**
 * Convention owned by this module: a `secretRef` is the id passed to the injected
 * `SecretStore`, and the plaintext stored there is `JSON.stringify(secret)` for an
 * `AccountSecret`. Callers that create accounts (the IPC layer, via `Provider.check`)
 * must save secrets this way for `port-manager` to be able to load them back.
 */
function loadAccountSecret(secrets: SecretStore, secretRef: string): AccountSecret | null {
  const raw = secrets.loadSecret(secretRef);
  if (raw == null) return null;
  return JSON.parse(raw) as AccountSecret;
}

/** The first non-internal IPv4 address, for `exportPorts`'s LAN-sharing host (reviewer
 * minor). Falls back to `127.0.0.1` if none is found (e.g. no network at all). */
function firstLanIPv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

/** The `retrying` reasonKeys that mean "this server is dead" (spec §6.8: handshake
 * timeout, `/delay` 503/504): `PortHealth`'s own timeout/unreachable/exited/verify
 * reasons. Deliberately NOT auth (that is a refusal, handled separately) nor
 * port-manager's own pre-engine reasons (`secret-unavailable`, `start-error`, …). */
const CONNECTIVITY_RETRY_REASONS = new Set(['timeout', 'unreachable', 'exited', 'verify-failed']);

/** How recent a confirmed-online on another server must be for an HMA auth failure to
 * count as that server refusing the device rather than the device creds being bad. */
const HMA_PROVEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long `rotatePort` waits for the restarted port to reach `online` before giving
 * up on confirming the new exit IP (reviewer item 1). */
const DEFAULT_ROTATE_ONLINE_TIMEOUT_MS = 45_000;

/** How many answers a round-robin pool hostname gets to name a server no other port
 * holds before the pick gives up on it (spec §6.8, Surfshark before discovery). */
const POOL_HOSTNAME_ATTEMPTS = 4;

async function defaultResolveServer(server: string, opts: { fresh?: boolean } = {}): Promise<string> {
  if (isIP(server)) return server;
  if (opts.fresh) {
    try {
      const all = await resolve4(server);
      if (all.length > 0) return all[Math.floor(Math.random() * all.length)];
    } catch {
      // Fall back to the OS resolver (it may know hosts the DNS server does not).
    }
  }
  const { address } = await lookup(server, { family: 4 });
  return address;
}

/** A hostname of a provider whose hostnames are round-robin pools: one token, many
 * servers. Never an IP literal. */
function isPoolHostname(target: Target, server: string): boolean {
  return target.poolHostnames === true && !isIP(server);
}

function defaultScheduleRetry(ms: number, cb: () => void): () => void {
  const timer = setTimeout(cb, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * What an auth failure on one server means, per provider (spec §5.1, §5.2). This table
 * is the only provider-specific part of the failover; everything else works on
 * (account, server) pairs.
 *   'refused'     — this server refused this account: mark it and move on.
 *   'credentials' — the account itself is rejected: stay `failed(auth)`.
 *   'unproven'    — could be either (ZoogVPN without enough evidence yet): mark the
 *                   server dead for the account (2 h, not the 7-day refusal) and move
 *                   on, so failures on distinct servers accumulate until one of the
 *                   two above can be decided.
 */
type AuthVerdict = 'refused' | 'credentials' | 'unproven';

/** One server's identity for the allocation invariant (spec §6.8). Each part is compared
 * only with its own kind (a Surfshark exit IP is the server IP + 1, which may well be
 * another server's own IP). */
interface Identity {
  token: string;
  ip?: string;
  /** The exit IP last observed through `ip`. */
  exit?: string;
}

/** Same machine = same observed exit IP, else same resolved IP. The token decides only
 * while an IP is unknown: different hostnames can point at one machine, and one
 * round-robin hostname (a Surfshark cluster before its pool is discovered) at many. */
function sameMachine(a: Identity, b: Identity): boolean {
  if (a.exit !== undefined && a.exit === b.exit) return true;
  if (a.ip !== undefined && b.ip !== undefined) return a.ip === b.ip;
  return a.token === b.token;
}

interface ServerPick {
  server: string;
  ip: string;
}

interface SelectOptions {
  target: Target;
  accountId: string;
  /** The port being placed (its own server never counts as held), if it exists yet. */
  portKey?: string;
  /** 'restart' keeps `pinned` while usable and, with no usable server left, falls back
   * to dead and then refused ones (retrying beats stranding the port); 'strict' (add a
   * port, Change IP) only ever takes a usable server. */
  mode: 'restart' | 'strict';
  pinned?: string;
  /** Never pick this server or anything that is the same machine (Change IP). */
  exclude?: Identity;
  /** Change IP: cycle through the pool from the current server instead of best-first. */
  roundRobinFrom?: string;
}

export function createPortManager(deps: PortManagerDeps): PortManager {
  const getLanIPv4 = deps.getLanIPv4 ?? firstLanIPv4;
  const refusals = deps.refusals ?? createRefusalTracker({ initial: deps.state.getState().refusals });
  const rotateOnlineTimeoutMs = deps.rotateOnlineTimeoutMs ?? DEFAULT_ROTATE_ONLINE_TIMEOUT_MS;
  const scheduleRetryFn = deps.scheduleRetry ?? defaultScheduleRetry;
  const backoffRng = deps.backoffRng ?? Math.random;
  const resolveServer = deps.resolveServer ?? defaultResolveServer;
  const health = deps.serverHealth ?? createServerHealth({ initial: deps.state.getState().serverHealth });
  /** server token -> last resolved IPv4, for the invariant check and `listServers`. */
  const resolvedIp = new Map<string, string>();
  /** server IP -> exit IP observed through it; exit IP = server identity (§6.5). */
  const exitByIp = new Map<string, string>();
  /** Each port's location as of its last start/add/rotate, for synchronous failover checks. */
  const portTargets = new Map<string, Target>();

  // §4.2/§6.5 auto-rotate timers (reviewer item 8): this module owns syncing them.
  const autoRotate = deps.autoRotate ?? createAutoRotateScheduler({ rotate: (k) => rotatePort(k) });

  // Per-key lock so a webhook rotate, an auto-rotate tick, and a UI-triggered rotate
  // can never run concurrently against the same port (reviewer item 10). A rotate that
  // moves the port to another location holds its new key here too.
  const rotatingKeys = new Set<string>();

  function persistRefusals(): void {
    deps.state.setState((st) => ({ ...st, refusals: refusals.serialize() }));
  }

  function persistHealth(): void {
    deps.state.setState((st) => ({ ...st, serverHealth: health.serialize() }));
  }

  function findPort(key: string): PortRow | undefined {
    return deps.state.getState().ports.find((p) => p.key === key);
  }

  function updatePort(key: string, patch: Partial<PortRow>): void {
    deps.state.setState((s) => ({
      ...s,
      ports: s.ports.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    }));
  }

  function takenProxyPorts(): Set<number> {
    return new Set(deps.state.getState().ports.map((p) => p.proxyPort));
  }

  /** `n` for a new port of `locationKey`: the smallest free number, starting at 1. */
  function nextPortNumber(locationKey: string): number {
    const used = new Set<number>();
    for (const p of deps.state.getState().ports) {
      const parts = splitPortKey(p.key);
      if (parts && parts.locationKey === locationKey) used.add(parts.n);
    }
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  }

  function knownIp(server: string): string | undefined {
    return isIP(server) ? server : resolvedIp.get(server);
  }

  function identityOf(server: string, ip?: string): Identity {
    const resolved = ip ?? knownIp(server);
    return { token: server, ip: resolved, exit: resolved === undefined ? undefined : exitByIp.get(resolved) };
  }

  /**
   * Every port of `providerId` other than `exceptKey` that holds a server. Stopped ports
   * keep holding their pin (stricter than spec §6.8's "enabled ports"): §6.2 has a port
   * keep its server across restarts, and the Change-IP menu shows it as taken.
   */
  function holders(providerId: ProviderId, exceptKey?: string): Array<{ key: string; id: Identity }> {
    const out: Array<{ key: string; id: Identity }> = [];
    for (const p of deps.state.getState().ports) {
      if (p.providerId !== providerId || !p.server || p.key === exceptKey) continue;
      const id = identityOf(p.server, p.serverIp);
      if (!id.exit && p.state.kind === 'online') id.exit = p.state.exitIp;
      out.push({ key: p.key, id });
    }
    return out;
  }

  function heldBy(providerId: ProviderId, id: Identity, exceptKey?: string): string | undefined {
    return holders(providerId, exceptKey).find((h) => sameMachine(h.id, id))?.key;
  }

  /** 0 usable, 1 dead (not refused), 2 refused — the restart path's fallback tiers. */
  function tier(accountId: string, server: string): number {
    if (health.isRefused(accountId, server)) return 2;
    return health.isDead(accountId, server) ? 1 : 0;
  }

  function orderCandidates(opts: SelectOptions): string[] {
    const pool = opts.target.servers;
    const index = new Map(pool.map((s, i) => [s, i]));
    let order: string[];
    if (opts.roundRobinFrom !== undefined && pool.includes(opts.roundRobinFrom)) {
      const at = index.get(opts.roundRobinFrom)!;
      order = [...pool.slice(at + 1), ...pool.slice(0, at + 1)];
    } else {
      order = [...pool].sort((a, b) => {
        const okA = health.lastOk(opts.accountId, a) ?? 0;
        const okB = health.lastOk(opts.accountId, b) ?? 0;
        return okA !== okB ? okB - okA : index.get(a)! - index.get(b)!;
      });
    }
    if (opts.pinned !== undefined && order.includes(opts.pinned)) order = [opts.pinned, ...order.filter((s) => s !== opts.pinned)];
    // Stable sort: usable first, keeping the order above within each tier.
    const ranked = order.map((s) => ({ s, t: tier(opts.accountId, s) }));
    const allowed = opts.mode === 'strict' ? ranked.filter((r) => r.t === 0) : ranked;
    return allowed.sort((a, b) => a.t - b.t).map((r) => r.s);
  }

  /**
   * Picks a server for a port (spec §6.8): free (no other enabled port of the provider
   * holds the same machine, compared on resolved IP), usable for the account, best
   * first. Resolves hostnames on the way; a host that no longer resolves is marked dead.
   * Must run under `withClaimLock`, together with writing the pick to the row.
   */
  async function selectServer(opts: SelectOptions): Promise<{ pick?: ServerPick; dnsFailed: boolean }> {
    let dnsFailed = false;
    for (const server of orderCandidates(opts)) {
      // An IP literal is its own identity; a hostname is judged on what it resolves to now.
      if (opts.exclude && isIP(server) && opts.exclude.token === server) continue;
      // A round-robin pool hostname is asked again while its answer is held by another
      // port (or is the machine being left): the next answer may name a free server.
      const pool = isPoolHostname(opts.target, server);
      for (let attempt = 0; attempt < (pool ? POOL_HOSTNAME_ATTEMPTS : 1); attempt++) {
        let ip: string;
        try {
          ip = await resolveServer(server, pool ? { fresh: true } : undefined);
        } catch {
          dnsFailed = true;
          health.markDead(opts.accountId, server); // the host vanished from DNS
          break;
        }
        resolvedIp.set(server, ip);
        const id = identityOf(server, ip);
        if (opts.exclude && sameMachine(opts.exclude, id)) continue;
        if (heldBy(opts.target.providerId, id, opts.portKey)) continue;
        return { pick: { server, ip }, dnsFailed };
      }
    }
    return { dnsFailed };
  }

  /** Synchronous "is there somewhere else to go" check for failover, on cached IPs. */
  function hasUsableAlternative(port: PortRow, accountId: string, includeCurrent: boolean): boolean {
    const target = portTargets.get(port.key);
    if (!target) return false;
    const current = port.server ? identityOf(port.server, port.serverIp) : undefined;
    return target.servers.some((s) => {
      if (!health.isUsable(accountId, s)) return false;
      const id = identityOf(s);
      if (!includeCurrent && current && sameMachine(current, id)) return false;
      return !heldBy(port.providerId, id, port.key);
    });
  }

  // Serializes every select-and-claim (and row creation with its proxy port), so two
  // concurrent operations never read the same "held servers / ports in use" snapshot
  // before either has written back (reviewer item 5, spec §6.8 invariant).
  let claimChain: Promise<unknown> = Promise.resolve();
  function withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = claimChain.then(fn, fn);
    claimChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Real retry-timer bookkeeping for the handful of failures port-manager itself owns
  // (reviewer item 7): pre-flight states that never reached `PortHealth`. `PortHealth`'s
  // OWN `retrying`/`failed` states already have their own backoff timer inside the
  // engine (`onRetryDue`) — this is only for the states set directly here.
  const localRetryAttempts = new Map<string, number>();
  const localRetryCancel = new Map<string, () => void>();

  function cancelLocalRetry(key: string): void {
    localRetryCancel.get(key)?.();
    localRetryCancel.delete(key);
  }

  /** Resets the local backoff counter and cancels any pending timer — called once a
   * `startPort` hands a key off to the real engine successfully, and whenever the user
   * explicitly stops or removes a port (no more surprise restarts). */
  function clearLocalRetryAttempts(key: string): void {
    localRetryAttempts.delete(key);
    cancelLocalRetry(key);
  }

  type RetryableOutcome = { kind: 'retrying'; reasonKey: string } | { kind: 'failed'; reason: FailReason };

  /** Sets a `retrying`/`failed` state with a REAL schedule behind its countdown
   * (reviewer item 7), on the shared backoff schedule (`health/backoff.ts`), retrying
   * forever per spec's `giveUpAfter: 0` default until the user stops/removes the port. */
  function failWithRetry(key: string, outcome: RetryableOutcome): void {
    const attempt = (localRetryAttempts.get(key) ?? 0) + 1;
    localRetryAttempts.set(key, attempt);
    const delayMs = nextBackoffMs(attempt - 1, backoffRng);
    const untilMs = Date.now() + delayMs;
    const state: PortState =
      outcome.kind === 'retrying'
        ? { kind: 'retrying', untilMs, attempt, reasonKey: outcome.reasonKey }
        : { kind: 'failed', reason: outcome.reason, untilMs, attempt };
    updatePort(key, { state });
    armLocalRetry(key, delayMs);
  }

  function armLocalRetry(key: string, delayMs: number): void {
    cancelLocalRetry(key);
    const cancel = scheduleRetryFn(delayMs, () => {
      localRetryCancel.delete(key);
      // A Change IP in flight owns the port's restart; if it ends without moving the
      // port, this retry is still owed, so it waits another round instead of racing it.
      if (rotatingKeys.has(key)) return armLocalRetry(key, delayMs);
      void startPort(key).catch(() => undefined);
    });
    localRetryCancel.set(key, cancel);
  }

  /** Shows `retrying(reasonKey)` and restarts the port right away; `startPort`
   * re-selects, so it lands on another server. Deferred: callers run inside the
   * engine's state-change callback. */
  function restartElsewhere(key: string, reasonKey: string, patch: Partial<PortRow> = {}): void {
    updatePort(key, { ...patch, state: { kind: 'retrying', untilMs: Date.now(), attempt: 1, reasonKey } });
    setTimeout(() => {
      if (findPort(key)?.enabled) void startPort(key).catch(() => undefined); // not if stopped meanwhile
    }, 0);
  }

  /** Moves an enabled port off its current server if a usable free one remains for its
   * account (spec §6.8 failover). False when there is nowhere to go. */
  function failOver(key: string, reasonKey: string): boolean {
    const port = findPort(key);
    if (!port || !port.enabled || rotatingKeys.has(key)) return false;
    if (!hasUsableAlternative(port, port.accountId, false)) return false;
    restartElsewhere(key, reasonKey);
    return true;
  }

  /** §4.2 "move a port on refusal": another account of the provider that may still use
   * a free server of this location (a server refused for one account may still be used
   * by another — spec §6.8). Never for files: a file IS its account. */
  function moveToAnotherAccount(key: string): boolean {
    const port = findPort(key);
    if (!port || !port.enabled || rotatingKeys.has(key) || !deps.pool || port.providerId === 'file') return false;
    const next = deps.pool.pickAccount(port.providerId, { exclude: port.accountId, forPortKey: key });
    if (!next || !hasUsableAlternative(port, next.id, true)) return false;
    restartElsewhere(key, 'server-refused', { accountId: next.id });
    return true;
  }

  /** The port's account demonstrably works: another of its ports is online, or it was
   * confirmed online on another server recently. */
  function accountWorksElsewhere(port: PortRow & { server: string }): boolean {
    const otherOnline = deps.state
      .getState()
      .ports.some((p) => p.key !== port.key && p.accountId === port.accountId && p.state.kind === 'online');
    return otherOnline || health.workedRecently(port.accountId, HMA_PROVEN_WINDOW_MS, port.server);
  }

  function authVerdict(port: PortRow & { server: string }): AuthVerdict {
    // §5.1: device creds, per-server tenant — but a refusal only once the creds are known
    // to work somewhere; otherwise (stale or revoked device creds) walking the pool would
    // just mark every server refused for a week.
    if (port.providerId === 'hma') return accountWorksElsewhere(port) ? 'refused' : 'credentials';
    if (port.providerId === 'zoogvpn') {
      refusals.recordAuthFailure(port.accountId, port.server);
      const verdict = refusals.classifyAuthFailure(port.accountId);
      return verdict === 'not-in-plan' ? 'refused' : verdict === 'bad-login' ? 'credentials' : 'unproven';
    }
    return 'credentials';
  }

  /** A `failed(auth)` from the engine (spec §6.8 "server refused"). */
  function onAuthFailure(port: PortRow & { server: string }, state: Extract<PortState, { kind: 'failed' }>): void {
    const verdict = authVerdict(port);
    if (verdict === 'credentials') return; // stays failed(auth), long back-off
    if (verdict === 'unproven') {
      // Stays failed(auth) only if there is nowhere else to gather evidence.
      health.markDead(port.accountId, port.server);
      failOver(port.key, 'server-refused');
      return;
    }
    health.markRefused(port.accountId, port.server);
    persistHealth();
    if (failOver(port.key, 'server-refused')) return;
    if (moveToAnotherAccount(port.key)) return;
    // Nothing left: failed(auth) for HMA, failed(not-in-plan) for a plan refusal.
    if (port.providerId === 'zoogvpn') updatePort(port.key, { state: { ...state, reason: 'not-in-plan' } });
  }

  /** The exit-IP probe is the invariant's final check (spec §6.8): a port whose exit IP
   * equals another enabled port's of the same provider moves to another server. */
  function onOnline(port: PortRow & { server: string }, exitIp: string): void {
    const serverIp = port.serverIp ?? knownIp(port.server);
    if (serverIp) exitByIp.set(serverIp, exitIp);
    if (rotatingKeys.has(port.key)) return;
    const clash = deps.state
      .getState()
      .ports.some((p) => p.key !== port.key && p.enabled && p.providerId === port.providerId && p.state.kind === 'online' && p.state.exitIp === exitIp);
    if (!clash) return;
    if (failOver(port.key, 'duplicate-exit')) return;
    void deps.engine
      .stop(port.key)
      .catch(() => undefined)
      .then(() => failWithRetry(port.key, { kind: 'failed', reason: 'no-server' }));
  }

  // `PortHealth` (inside the real `Engine`) OWNS `PortRow.state` — this is the one place
  // port-manager persists its transitions (reviewer item 6), and the one place server
  // health is learned: `online` = OK (and the exit-IP invariant check), a connectivity
  // `retrying` = dead (2 h), a `failed(auth)` = possibly refused (see `authVerdict`).
  deps.engine.onStateChange((key, state) => {
    updatePort(key, { state });
    const port = findPort(key);
    if (!port?.server) return;
    const pinned = port as PortRow & { server: string };

    if (state.kind === 'online') {
      health.markOk(port.accountId, port.server);
      persistHealth();
    }
    if (port.providerId === 'zoogvpn') {
      if (state.kind === 'online') refusals.recordOnline(port.accountId, port.server);
      else refusals.clearOnline(port.accountId, port.server);
    }

    if (state.kind === 'online') {
      onOnline(pinned, state.exitIp);
    } else if (state.kind === 'retrying' && CONNECTIVITY_RETRY_REASONS.has(state.reasonKey)) {
      health.markDead(port.accountId, port.server);
      failOver(key, 'server-dead');
    } else if (state.kind === 'failed' && state.reason === 'auth') {
      onAuthFailure(pinned, state);
    }
    if (port.providerId === 'zoogvpn') persistRefusals();
  });

  // §6.4 health-driven retry: when a port's back-off elapses, re-run `startPort` rather
  // than letting the engine respawn its stale config in place (reviewer I-1): the start
  // path re-resolves and re-selects, so a dead server fails over (spec §6.8). A rotate
  // in flight already does its own stop+start, so skip the retry then.
  deps.engine.onRetryDue?.((key) => {
    if (rotatingKeys.has(key)) return;
    void startPort(key).catch(() => undefined);
  });

  /** Resolves once `Engine.onStateChange` reports `online` (true) or `failed` (false)
   * for `targetKey`, or after `timeoutMs` with no verified transition at all (false) —
   * never trusts a post-restart probe before the tunnel is actually confirmed up
   * (reviewer item 1). */
  function waitForOnlineOrTimeout(targetKey: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const unsubscribe = deps.engine.onStateChange((k, state) => {
        if (k !== targetKey || settled) return;
        if (state.kind === 'online' || state.kind === 'failed') {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(state.kind === 'online');
        }
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /**
   * Builds the sing-box render input for `port`. Enforces, independently of whatever
   * `settings.lanSharing` says, that a `0.0.0.0` listen is only ever used when a real
   * proxy username/password is set (reviewer critical item 1).
   *
   * `clash` is a placeholder: the real `Engine` allocates its OWN clash_api port +
   * secret per spawn and overwrites this field before rendering (reviewer item 10).
   */
  function buildRenderInput(port: PortRow, endpoint: RenderInput['endpoint']): RenderInput {
    const { settings } = deps.state.getState();
    const hasAuth = Boolean(settings.proxyUser && settings.proxyPass);
    return {
      endpoint,
      listen: {
        host: settings.lanSharing && hasAuth ? '0.0.0.0' : '127.0.0.1',
        port: port.proxyPort,
        proxyAuth: hasAuth ? { username: settings.proxyUser, password: settings.proxyPass } : undefined,
      },
      clash: { port: 0, secret: '' },
    };
  }

  function proxyAuthFromSettings(): { username: string; password: string } | undefined {
    const { settings } = deps.state.getState();
    return settings.proxyUser && settings.proxyPass ? { username: settings.proxyUser, password: settings.proxyPass } : undefined;
  }

  async function addPort(target: Target, accountId: string, opts: { atLimit?: () => boolean } = {}): Promise<PortRow | undefined> {
    return withClaimLock(async () => {
      if (opts.atLimit?.()) return undefined;
      const { pick } = await selectServer({ target, accountId, mode: 'strict' });
      if (!pick) return undefined;
      const { settings } = deps.state.getState();
      const proxyPort = await deps.allocator.allocate({ preferred: settings.basePort, taken: takenProxyPorts(), base: settings.basePort });
      const row: PortRow = {
        key: makePortKey(target.key, nextPortNumber(target.key)),
        locationKey: target.key,
        server: pick.server,
        serverIp: pick.ip,
        providerId: target.providerId,
        accountId,
        label: target.label,
        country: target.country,
        city: target.city,
        proxyPort,
        enabled: true,
        state: { kind: 'queued' },
        autoRotateMin: 0,
      };
      portTargets.set(row.key, target);
      deps.state.setState((s) => ({ ...s, ports: [...s.ports, row] }));
      return row;
    });
  }

  async function startPort(key: string): Promise<void> {
    try {
      const s = deps.state.getState();
      const port = s.ports.find((p) => p.key === key);
      // Removed, or renamed by a Change IP to another city, since this start was due:
      // nothing to start, and nothing to retry (a retry would only find it gone again).
      if (!port) return;
      // The user stopped the port while this start was awaiting: it must not come back on.
      // (Only for a start that began on an enabled row — a direct start of a stopped row
      // is what turns it on.)
      const stoppedMeanwhile = () => port.enabled && findPort(key)?.enabled === false;
      const account = s.accounts.find((a) => a.id === port.accountId);
      const provider = account && deps.providers.get(port.providerId);
      if (!account || !provider) {
        updatePort(key, { enabled: false, state: { kind: 'failed', reason: 'no-server', untilMs: Date.now(), attempt: 1 } });
        return;
      }
      const secret = loadAccountSecret(deps.secrets, account.secretRef);
      if (!secret) {
        // A decrypt/read failure is not proof the credentials are wrong: retry instead
        // of a terminal `failed(auth)` (reviewer minor), on a real backoff timer.
        updatePort(key, { enabled: true });
        failWithRetry(key, { kind: 'retrying', reasonKey: 'secret-unavailable' });
        return;
      }

      const target = (await provider.targets(account)).find((t) => t.key === port.locationKey);
      if (stoppedMeanwhile()) return;
      if (!target) {
        updatePort(key, { enabled: true });
        failWithRetry(key, { kind: 'failed', reason: 'no-server' });
        return;
      }
      portTargets.set(key, target);

      // Re-select on every (re)start (spec §6.8 failover): keep the pinned server while
      // it is usable and free, otherwise move to the best one that is.
      const selected = await withClaimLock(async () => {
        const fresh = findPort(key);
        if (!fresh || stoppedMeanwhile()) return undefined;
        const result = await selectServer({ target, accountId: fresh.accountId, portKey: key, mode: 'restart', pinned: fresh.server });
        if (stoppedMeanwhile()) return undefined; // stopped while resolving
        // Claimed together with `enabled`, so the next selection already sees it held.
        updatePort(key, result.pick ? { enabled: true, server: result.pick.server, serverIp: result.pick.ip } : { enabled: true });
        return result;
      });
      if (!selected) return; // removed or stopped meanwhile
      if (!selected.pick) {
        failWithRetry(key, selected.dnsFailed ? { kind: 'retrying', reasonKey: 'dns-failed' } : { kind: 'failed', reason: 'no-server' });
        return;
      }

      const endpoint = provider.bind(target, selected.pick.ip, account, secret);
      const renderInput = buildRenderInput(findPort(key) ?? port, endpoint);
      try {
        await deps.engine.start(key, renderInput);
      } catch (err) {
        if (err instanceof PortInUseError) {
          failWithRetry(key, { kind: 'failed', reason: 'port-in-use' });
          return;
        }
        throw err;
      }
      // Handed off to the engine: from here, retry/backoff is PortHealth's own.
      clearLocalRetryAttempts(key);
    } catch (err) {
      // Never leave the row stuck in `connecting` (reviewer item 7).
      failWithRetry(key, { kind: 'retrying', reasonKey: 'start-error' });
      throw err;
    } finally {
      syncAutoRotate();
    }
  }

  async function stopPort(key: string): Promise<void> {
    cancelLocalRetry(key); // the user explicitly stopped it — no surprise restarts later
    await deps.engine.stop(key);
    updatePort(key, { enabled: false, state: { kind: 'stopped' } });
    syncAutoRotate();
  }

  async function removePort(key: string): Promise<void> {
    cancelLocalRetry(key);
    portTargets.delete(key);
    await deps.engine.stop(key).catch(() => undefined);
    deps.state.setState((s) => ({ ...s, ports: s.ports.filter((p) => p.key !== key) }));
    syncAutoRotate();
  }

  /** Change IP (spec §6.5): restarts only this port on another server, then confirms
   * the exit IP actually changed before reporting success. */
  async function rotatePort(key: string, toServer?: string): Promise<RotateResult> {
    if (rotatingKeys.has(key)) return { changed: false, noteKey: 'rotate-in-progress' };
    rotatingKeys.add(key);
    // The row the user is looking at may be renamed partway (same-country fallback);
    // any throw after that must be attributed to the new key (reviewer round 3, item 2).
    const effectiveKey = { current: key };
    try {
      return await doRotate(key, toServer, effectiveKey);
    } catch (err) {
      failWithRetry(effectiveKey.current, { kind: 'retrying', reasonKey: 'rotate-error' });
      throw err;
    } finally {
      rotatingKeys.delete(key);
      rotatingKeys.delete(effectiveKey.current);
      syncAutoRotate();
    }
  }

  interface RotateClaim {
    target: Target;
    pick: ServerPick;
    account: Account;
    finalKey: string;
    fellBackToAnotherCity: boolean;
  }

  async function doRotate(key: string, toServer: string | undefined, effectiveKey: { current: string }): Promise<RotateResult> {
    const s = deps.state.getState();
    const port = s.ports.find((p) => p.key === key);
    if (!port) return { changed: false, noteKey: 'no-server' };
    if (!port.enabled) return { changed: false, noteKey: 'port-disabled' }; // never (re)start a disabled port
    const account = s.accounts.find((a) => a.id === port.accountId);
    const provider = account && deps.providers.get(port.providerId);
    if (!account || !provider) return { changed: false, noteKey: 'no-server' };
    // Distinct from "no-server" (reviewer item 10): it's the stored credential that
    // couldn't be read back.
    if (!loadAccountSecret(deps.secrets, account.secretRef)) return { changed: false, noteKey: 'decrypt-failed' };

    // Which account owns each candidate location. For catalog providers every account
    // sees the same locations, so Change IP stays on the port's account. An imported
    // file, though, IS one location per account — so a same-country fallback for a file
    // port looks across every imported file (integration fix).
    const ownerByKey = new Map<string, Account>();
    const candidateAccounts =
      port.providerId === 'file' ? [account, ...s.accounts.filter((a) => a.providerId === 'file' && a.id !== account.id)] : [account];
    const targets: Target[] = [];
    for (const acc of candidateAccounts) {
      for (const t of await provider.targets(acc)) {
        if (ownerByKey.has(t.key)) continue;
        ownerByKey.set(t.key, acc);
        targets.push(t);
      }
    }
    const currentTarget = targets.find((t) => t.key === port.locationKey);

    const claim = await withClaimLock(async (): Promise<RotateClaim | { noteKey: string }> => {
      const fresh = findPort(key);
      if (!fresh) return { noteKey: 'no-server' }; // removed mid-rotate
      const current = fresh.server ? identityOf(fresh.server, fresh.serverIp) : undefined;

      if (toServer !== undefined) {
        // The Change-IP menu's explicit pick: must be a free, usable server of this location.
        if (!currentTarget || !currentTarget.servers.includes(toServer)) return { noteKey: 'server-unavailable' };
        if (toServer === fresh.server) return { noteKey: 'already-on-server' };
        if (!health.isUsable(fresh.accountId, toServer)) return { noteKey: 'server-unavailable' };
        let ip: string;
        try {
          ip = await resolveServer(toServer);
        } catch {
          health.markDead(fresh.accountId, toServer);
          return { noteKey: 'server-unavailable' };
        }
        resolvedIp.set(toServer, ip);
        if (heldBy(fresh.providerId, identityOf(toServer, ip), key)) return { noteKey: 'server-unavailable' };
        updatePort(key, { server: toServer, serverIp: ip });
        return { target: currentTarget, pick: { server: toServer, ip }, account, finalKey: key, fellBackToAnotherCity: false };
      }

      // 1. Another free usable server of the same location, cycling through the pool.
      if (currentTarget) {
        const { pick } = await selectServer({
          target: currentTarget,
          accountId: fresh.accountId,
          portKey: key,
          mode: 'strict',
          exclude: current,
          roundRobinFrom: fresh.server,
        });
        if (pick) {
          updatePort(key, { server: pick.server, serverIp: pick.ip });
          return { target: currentTarget, pick, account, finalKey: key, fellBackToAnotherCity: false };
        }
      }

      // 2. Another location in the same country (§6.5); the row moves to its group.
      const sameCountry = targets.filter((t) => t.key !== fresh.locationKey && t.country === fresh.country).sort((a, b) => a.key.localeCompare(b.key));
      for (const alt of sameCountry) {
        const altAccount = ownerByKey.get(alt.key) ?? account;
        const { pick } = await selectServer({ target: alt, accountId: altAccount.id, portKey: key, mode: 'strict', exclude: current });
        if (!pick) continue;
        const finalKey = makePortKey(alt.key, nextPortNumber(alt.key));
        // Rename NOW, before the engine is told about it (reviewer item 2): a state event
        // fired for `finalKey` must find its row.
        deps.state.setState((st) => ({
          ...st,
          ports: st.ports.map((p) =>
            p.key === key
              ? {
                  ...p,
                  key: finalKey,
                  locationKey: alt.key,
                  country: alt.country,
                  city: alt.city,
                  label: alt.label,
                  accountId: altAccount.id,
                  server: pick.server,
                  serverIp: pick.ip,
                }
              : p,
          ),
        }));
        return { target: alt, pick, account: altAccount, finalKey, fellBackToAnotherCity: true };
      }

      // 3. Nowhere to go: keep the current server.
      return { noteKey: 'no-server' };
    });

    if ('noteKey' in claim) return { changed: false, noteKey: claim.noteKey };
    // The rotate restarts the port itself: a local retry still pending from an earlier
    // failure must not fire into it (or, after a move, at a key that no longer exists).
    clearLocalRetryAttempts(key);
    const { target, pick, finalKey, fellBackToAnotherCity } = claim;
    effectiveKey.current = finalKey;
    rotatingKeys.add(finalKey);
    portTargets.delete(key);
    portTargets.set(finalKey, target);

    const auth = proxyAuthFromSettings();
    // The pre-rotate exit IP: known when online, else a real baseline probe rather than
    // treating "we have no idea" as license to call anything "changed" (reviewer item 10).
    let beforeIp = port.state.kind === 'online' ? port.state.exitIp : undefined;
    let beforeIpUnverifiable = false;
    if (beforeIp === undefined) {
      try {
        beforeIp = (await deps.exitIp.probe(port.proxyPort, auth)).ip;
      } catch {
        beforeIpUnverifiable = true;
      }
    }

    const nextSecret = loadAccountSecret(deps.secrets, claim.account.secretRef);
    if (!nextSecret) throw new Error(`rotate: credentials for ${claim.account.id} unreadable`);
    const endpoint = provider.bind(target, pick.ip, claim.account, nextSecret);
    const renderInput = buildRenderInput(port, endpoint);

    await deps.engine.stop(key);
    await deps.engine.start(finalKey, renderInput);

    // Wait for `PortHealth` to confirm the tunnel before probing (reviewer item 1).
    const reachedOnline = await waitForOnlineOrTimeout(finalKey, rotateOnlineTimeoutMs);
    let afterIp: string | undefined;
    if (reachedOnline) {
      try {
        afterIp = (await deps.exitIp.probe(port.proxyPort, auth)).ip;
      } catch {
        afterIp = undefined;
      }
    }

    const changed = !beforeIpUnverifiable && beforeIp !== undefined && afterIp !== undefined && afterIp !== beforeIp;
    const noteKey = beforeIpUnverifiable
      ? 'not-verified'
      : changed
        ? fellBackToAnotherCity
          ? 'rotated-to-another-city'
          : undefined
        : !reachedOnline
          ? 'online-timeout'
          : afterIp === undefined
            ? 'probe-failed'
            : 'exit-ip-unchanged';

    return { changed, from: beforeIp, to: afterIp, noteKey };
  }

  function listServers(target: Target, portKey?: string): ServerInfo[] {
    const { accounts: all, ports } = deps.state.getState();
    // Health is for one port's account when asked for (a server refused for another
    // account is still a valid pick for this port), else for the accounts this
    // location's ports use; with no port yet, for every account of the provider (any of
    // them may take the next one).
    const forPort = portKey === undefined ? undefined : ports.find((p) => p.key === portKey);
    const used = new Set(forPort ? [forPort.accountId] : ports.filter((p) => p.locationKey === target.key).map((p) => p.accountId));
    const ofProvider = all.filter((a) => a.providerId === target.providerId);
    const accounts = used.size > 0 ? ofProvider.filter((a) => used.has(a.id)) : ofProvider;
    return target.servers.map((server) => {
      const ip = knownIp(server);
      const holder = heldBy(target.providerId, identityOf(server));
      const lastOks = accounts.map((a) => health.lastOk(a.id, server)).filter((t): t is number => t !== undefined);
      const lastOk = lastOks.length > 0 ? Math.max(...lastOks) : undefined;
      // Usable by any of those accounts → ok/unknown; refused by every one → refused;
      // otherwise (some dead) → dead.
      const usable = accounts.length === 0 || accounts.some((a) => health.isUsable(a.id, server));
      const status: ServerInfo['health'] = usable
        ? lastOk !== undefined
          ? 'ok'
          : 'unknown'
        : accounts.every((a) => health.isRefused(a.id, server))
          ? 'refused'
          : 'dead';
      return {
        server,
        ...(ip ? { ip } : {}),
        health: status,
        ...(lastOk !== undefined ? { lastOk } : {}),
        ...(holder ? { heldBy: holder } : {}),
      };
    });
  }

  function freeServerCount(target: Target): number {
    // A pool hostname held by a port still counts: its next answer may be another server.
    return listServers(target).filter(
      (s) => (!s.heldBy || isPoolHostname(target, s.server)) && (s.health === 'ok' || s.health === 'unknown'),
    ).length;
  }

  async function setAutoRotate(key: string, minutes: number): Promise<void> {
    updatePort(key, { autoRotateMin: Math.max(0, Math.floor(minutes)) });
    syncAutoRotate();
  }

  function syncAutoRotate(): void {
    autoRotate.sync(deps.state.getState().ports);
  }

  async function exportPorts(keys: string[], format: ExportFormat): Promise<string> {
    const s = deps.state.getState();
    const host = s.settings.lanSharing ? getLanIPv4() : '127.0.0.1';
    const creds: ExportCreds = { host, user: s.settings.proxyUser, pass: s.settings.proxyPass };
    const ports = keys.map((k) => s.ports.find((p) => p.key === k)).filter((p): p is PortRow => Boolean(p));
    return exportLines(format, ports.map((p) => p.proxyPort), creds);
  }

  async function testPort(key: string, _speed: boolean): Promise<{ ok: boolean; exitIp?: string; latencyMs?: number; mbps?: number }> {
    const port = findPort(key);
    if (!port) return { ok: false };
    const startedAt = Date.now();
    try {
      const exit = await deps.exitIp.probe(port.proxyPort, proxyAuthFromSettings());
      return { ok: true, exitIp: exit.ip, latencyMs: Date.now() - startedAt };
      // The speed test itself runs in the facade (it owns the speed probe).
    } catch {
      return { ok: false };
    }
  }

  function credentialsChanged(accountId: string): void {
    health.forgetMarks(accountId);
    refusals.forgetFailures(accountId);
    persistHealth();
    persistRefusals();
  }

  return {
    startPort,
    stopPort,
    removePort,
    rotatePort,
    addPort,
    listServers,
    freeServerCount,
    setAutoRotate,
    exportPorts,
    testPort,
    syncAutoRotate,
    stopAutoRotate: () => autoRotate.stopAll(),
    credentialsChanged,
  };
}
