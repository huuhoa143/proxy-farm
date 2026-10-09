import { lookup, resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  EXIT_IP_MODELS,
  isTerminalState,
  makePortKey,
  splitPortKey,
  type Account,
  type AccountSecret,
  type ExportFormat,
  type FailDetail,
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
import type { CredentialCheck, StateStore } from '../store/state';
import { createCredentialProbe, freeHosts, isProbeKey, type CredentialProbe } from './credential-probe';
import { exportLines, type ExportCreds } from './export-format';
import { PortInUseError, type Engine, type ExitIpProber, type PortAllocator, type ProviderRegistry } from './ports';
import { createServerHealth, type ServerHealth } from './server-health';
import { createAttemptLimiter, createWgKeyGuard, type AttemptLimiter, type WgKeyGuard } from './provider-safety';

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
   * Auth-failure evidence per (account, server), the last resort of spec §5.2 when no
   * free-tier server can be reached (see accounts/refusals.ts).
   * @default a fresh tracker seeded from `AppState.refusals` (so it survives an app
   * restart) — the same instance should also be handed to `accounts/pool.ts`'s
   * `createAccountPool` so both see the same memory.
   */
  refusals?: RefusalTracker;
  /**
   * Live credential check against a provider's free-tier server (spec §5.2): tells a
   * wrong password from a server outside the plan. Injectable for tests.
   * @default the real probe (controller/credential-probe.ts) through `engine`, sharing
   * `attemptLimiter`.
   */
  credentialProbe?: CredentialProbe;
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
  /** Clock for the correlated-drop window (see `onConnectivityFailure`). @default Date.now */
  now?: () => number;
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
   * Called (coalesced, at most once per `healthChangedDelayMs`) after a server health mark
   * changed: refused, dead, confirmed online, marks forgotten, or a hostname resolved onto
   * another machine. What `listTargets` derives from them (`freeServers`, `notInPlan`)
   * may differ now, with no port taking or releasing a server. Optional.
   */
  onHealthChanged?: () => void;
  /** @default 100 */
  healthChangedDelayMs?: number;
  /** How long `listServers` waits for the location's unresolved hostnames. @default 2000 */
  listResolveTimeoutMs?: number;
  /**
   * The account pool (spec §4.2 "move a port on refusal"): when every free server of a
   * location has refused the port's account, the port may move to another account of
   * the same provider that can still use one. Optional; without it the port just fails.
   */
  pool?: Pick<AccountPool, 'pickAccount'>;
  /**
   * Caps handshake attempts per account across all of its ports (spec §6.4 "Provider
   * safety"): every engine start (start, retry, failover, Change IP) takes one.
   * @default ≤ 6 per minute per account, on `now`
   */
  attemptLimiter?: AttemptLimiter;
  /**
   * Stops retrying a WireGuard key that has never completed a handshake once it fails
   * several attempts in a row (spec §6.4 "Provider safety"). @default a fresh guard
   * seeded from `AppState.wgLockouts`; its locks are written back there.
   */
  wgKeyGuard?: WgKeyGuard;
}

/** Who asked for a start/Change IP. A user action resets the port's back-off; an
 * automatic one (app start, resume, a due retry, auto-rotate, the webhook) never does.
 *
 * A port in a terminal failure (`isTerminalState`: login refused, not in plan, key
 * rejected) is only ever restarted by a user action or by `retryTerminal`; every
 * automatic start leaves it as it is, with no engine running. */
export interface StartOptions {
  user?: boolean;
  /** Start even a terminally failed port, without counting as a user action: its
   * cause may be gone (the account's credentials were just replaced). */
  retryTerminal?: boolean;
}

export interface PortManager {
  startPort(key: string, opts?: StartOptions): Promise<void>;
  stopPort(key: string): Promise<void>;
  removePort(key: string): Promise<void>;
  /** Change IP (spec §6.5): to `toServer` when given, else the next free usable server. */
  rotatePort(key: string, toServer?: string, opts?: StartOptions): Promise<RotateResult>;
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
   * merged over the accounts the location's ports use. Hostnames of the location not
   * resolved yet this session are resolved first (in parallel, each once, waiting at
   * most `listResolveTimeoutMs`), so a hostname that is another name of a refused, dead
   * or held machine is shown as such before anyone picks it. */
  listServers(target: Target, portKey?: string): Promise<ServerInfo[]>;
  /** Servers of `target` that some account of its provider may use and no enabled port holds. */
  freeServerCount(target: Target): number;
  /** Every server of `target` has refused every account of its provider (spec §6.8):
   * the location is outside the user's plan(s). False with no account to judge by. */
  locationNotInPlan(target: Target): boolean;
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
   * refused/dead marks, auth-failure evidence and credential check gathered under the
   * old credentials, so no server stays shunned for days because of them. */
  credentialsChanged(accountId: string): void;
  /**
   * One live credential check (spec §5.2) for `secret`, which need not be saved yet (the
   * "Check" button runs it before storing a new password). Takes from the account's
   * attempt budget. Persists nothing: call `recordCredentialCheck` once the secret is
   * stored. 'unsupported' when the provider has no free-tier server.
   */
  checkCredentials(account: Account, secret: AccountSecret): Promise<CredentialVerdict>;
  /** Stores the result of `checkCredentials` for an account whose secret is now saved. */
  recordCredentialCheck(accountId: string, verdict: CredentialVerdict): void;
}

/** What a live credential check showed (spec §5.2): the login works, is wrong, or could
 * not be checked (no free-tier server reachable); 'unsupported' = nothing to ask. */
export type CredentialVerdict = 'verified' | 'rejected' | 'unverified' | 'unsupported';

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

/** The `retrying` reasonKeys that may mean "this server is dead" (spec §6.8: handshake
 * timeout, `/delay` 503/504): `PortHealth`'s own timeout/unreachable/exited/verify
 * reasons. Deliberately NOT auth (that is a refusal, handled separately) nor
 * port-manager's own pre-engine reasons (`secret-unavailable`, `start-error`, …).
 * Whether one actually condemns the server is `onConnectivityFailure`'s call. */
const CONNECTIVITY_RETRY_REASONS = new Set(['timeout', 'unreachable', 'unresponsive', 'exited', 'verify-failed']);

/** The `retrying` reasonKeys that mean "no handshake": the tunnel never answered. A
 * crash (`exited`) says nothing about the key, and `verify-failed` comes after a 200. */
const NO_HANDSHAKE_REASONS = new Set(['timeout', 'unreachable']);

/** A WireGuard account: Surfshark, NordVPN (NordLynx), or an imported WireGuard `.conf`.
 * Every port of such an account sends WireGuard handshakes, which fail silently (spec
 * §5.3, §5.5). */
function isWireguardAccount(account: Account, secret: AccountSecret | null): boolean {
  if (account.providerId === 'surfshark' || account.providerId === 'nordvpn') return true;
  return account.providerId === 'file' && secret?.kind === 'file' && /^\s*\[Interface\]/im.test(secret.content);
}

/** Connectivity failures of two different ports this close together are one incident
 * on the host or the provider's side, not two dead servers (spec §6.4). */
const CORRELATED_DROP_WINDOW_MS = 15_000;
/** How long an incident keeps every server of its scope unjudged; each further failure
 * inside it extends it. */
const INCIDENT_HOLD_MS = 2 * 60_000;
/** Failed fresh reconnects in a row before a server a port was online on is given up
 * (its exit IP is the port's identity, so it is not dropped on one bad minute). */
const STICKY_RECONNECT_FAILURES = 2;

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

/** At most one live credential check per account in this window when a port's login
 * is refused (spec §5.2). A user's "Check" is not throttled by it. */
export const CREDENTIAL_PROBE_INTERVAL_MS = 10 * 60_000;

/** How long the row shows "checking your sign-in" (two free hosts × 40 s, plus DNS). */
const CREDENTIAL_PROBE_BUDGET_MS = 90_000;

/** Where a credential probe's loopback proxy port is looked for: clear of the default
 * proxy range (29001…) and of the engine's clash_api range (40000…). */
const PROBE_PORT_BASE = 39_000;

/** One server's identity for the allocation invariant (spec §6.8). Each part is compared
 * only with its own kind: an exit IP need not be its server's IP (Surfshark: server IP
 * + 1; NordVPN: another address of the server's subnet, e.g. .1 → .22), and may well be
 * another server's own IP. */
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
  /** Tried right after `pinned` (before the best-first order): the server the port should
   * go back to when it has to leave `pinned`, e.g. the one it was on before a Change IP. */
  preferred?: string;
  /** 'restart' only: may fall back to a server refused for the account. Only a user
   * action may knock on a door that refused the account (spec §6.4): an automatic
   * restart onto a refused server is a handshake that is known to fail. */
  allowRefused?: boolean;
}

export function createPortManager(deps: PortManagerDeps): PortManager {
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tells `deps.onHealthChanged` once a burst of mark changes has settled. */
  function healthChanged(): void {
    if (!deps.onHealthChanged || healthTimer) return;
    healthTimer = setTimeout(() => {
      healthTimer = undefined;
      deps.onHealthChanged?.();
    }, deps.healthChangedDelayMs ?? 100);
    healthTimer.unref?.();
  }
  /** `inner`, reporting every mutation to `healthChanged`. */
  function observeHealth(inner: ServerHealth): ServerHealth {
    return {
      ...inner,
      noteIp(server, ip) {
        const changed = inner.noteIp(server, ip);
        if (changed) healthChanged();
        return changed;
      },
      markOk(accountId, server) {
        const wasUsable = inner.isUsable(accountId, server);
        const hadOk = inner.lastOk(accountId, server) !== undefined;
        inner.markOk(accountId, server);
        // Only a cleared mark or a first "ok" changes what the UI shows.
        if (!wasUsable || !hadOk) healthChanged();
      },
      markRefused(accountId, server) {
        inner.markRefused(accountId, server);
        healthChanged();
      },
      markDead(accountId, server) {
        inner.markDead(accountId, server);
        healthChanged();
      },
      forgetMarks(accountId) {
        inner.forgetMarks(accountId);
        healthChanged();
      },
      forgetRefusalsSince(accountId, sinceMs) {
        inner.forgetRefusalsSince(accountId, sinceMs);
        healthChanged();
      },
    };
  }

  const getLanIPv4 = deps.getLanIPv4 ?? firstLanIPv4;
  const refusals = deps.refusals ?? createRefusalTracker({ initial: deps.state.getState().refusals });
  const rotateOnlineTimeoutMs = deps.rotateOnlineTimeoutMs ?? DEFAULT_ROTATE_ONLINE_TIMEOUT_MS;
  const scheduleRetryFn = deps.scheduleRetry ?? defaultScheduleRetry;
  const backoffRng = deps.backoffRng ?? Math.random;
  const now = deps.now ?? Date.now;
  const resolveServer = deps.resolveServer ?? defaultResolveServer;
  const health = observeHealth(deps.serverHealth ?? createServerHealth({ initial: deps.state.getState().serverHealth }));
  const limiter = deps.attemptLimiter ?? createAttemptLimiter({ now });
  const wgGuard = deps.wgKeyGuard ?? createWgKeyGuard({ now, initial: deps.state.getState().wgLockouts });
  /** Proxy ports of credential probes, from allocation until their engine stopped. */
  const probePorts = new Set<number>();
  /** Probe port allocations run one at a time: two scanning at once would both see the
   * same port free (it is added to `probePorts` only once a scan returns). */
  let probeAllocChain: Promise<unknown> = Promise.resolve();
  function allocateProbePort(): Promise<number> {
    const run = probeAllocChain.then(async () => {
      const port = await deps.allocator.allocate({ base: PROBE_PORT_BASE, taken: takenProxyPorts() });
      probePorts.add(port);
      return port;
    });
    probeAllocChain = run.catch(() => undefined);
    return run;
  }
  const credentialProbe =
    deps.credentialProbe ??
    createCredentialProbe({
      engine: deps.engine,
      resolveServer: (server) => resolveServer(server),
      allocatePort: allocateProbePort,
      releasePort: (port) => probePorts.delete(port),
      limiter,
    });
  /** Providers with a free-tier server to check a login against (spec §5.2), learned
   * from their targets on every start. */
  const freeTierProviders = new Map<ProviderId, boolean>();
  /** accountId -> epoch ms of its last live credential check from a port's refusal. */
  const lastProbeAt = new Map<string, number>();
  /** accountId -> the live credential check in flight, shared by all of its ports. */
  const probesInFlight = new Map<string, Promise<CredentialVerdict>>();
  /** accountId -> bumped whenever its credentials change, so a check of the old ones
   * that ends afterwards is not applied to the new ones. */
  const credentialEpoch = new Map<string, number>();
  /** accountId -> whether it is a WireGuard account (needs its secret; cached). */
  const wgAccounts = new Map<string, boolean>();
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
  /** port key -> the server it was on before its last Change IP within its location,
   * until it is online again. If the new server refuses it, the failover goes back
   * there first (spec §6.5: a refused pick must not cost the port its working server). */
  const returnTo = new Map<string, string>();

  function persistRefusals(): void {
    deps.state.setState((st) => ({ ...st, refusals: refusals.serialize() }));
  }

  function persistHealth(): void {
    deps.state.setState((st) => ({ ...st, serverHealth: health.serialize() }));
  }

  function persistLockouts(): void {
    deps.state.setState((st) => ({ ...st, wgLockouts: wgGuard.serialize() }));
  }

  function isWireguard(accountId: string): boolean {
    const cached = wgAccounts.get(accountId);
    if (cached !== undefined) return cached;
    const account = deps.state.getState().accounts.find((a) => a.id === accountId);
    if (!account) return false;
    const wg = isWireguardAccount(account, loadAccountSecret(deps.secrets, account.secretRef));
    wgAccounts.set(accountId, wg);
    return wg;
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

  /** A row moved to another server (Change IP, failover, a move to another city): the
   * old tunnel's exit IP and latency no longer describe it, and its proxy port is down
   * until the new engine is up, so it shows `connecting` until `PortHealth` verifies the
   * new tunnel. Applied with the server change itself, never after the engine starts. */
  function onNewServer(server: string, serverIp: string): Partial<PortRow> {
    return { server, serverIp, state: { kind: 'connecting', since: Date.now() } };
  }

  /** Every proxy port in use: the ports' own, and those of credential probes running. */
  function takenProxyPorts(): Set<number> {
    return new Set([...deps.state.getState().ports.map((p) => p.proxyPort), ...probePorts]);
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

  /** The server's IP: resolved this session, else the last one remembered by `health`. */
  function knownIp(server: string): string | undefined {
    return isIP(server) ? server : (resolvedIp.get(server) ?? health.ipOf(server));
  }

  /** Records what `server` resolved to. Its health marks follow the machine (§6.8): a
   * server refused under another name is refused under this one too. Not for a
   * round-robin pool hostname, which names many machines. */
  function noteResolved(target: Target, server: string, ip: string): void {
    resolvedIp.set(server, ip);
    if (!isPoolHostname(target, server) && health.noteIp(server, ip)) persistHealth();
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

  /** Highest tier a selection may use: strict = usable only; restart = dead too, and
   * refused only when allowed. */
  function maxTierOf(opts: SelectOptions): number {
    return opts.mode === 'strict' ? 0 : opts.allowRefused ? 2 : 1;
  }

  function orderCandidates(opts: SelectOptions): Array<{ s: string; t: number }> {
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
    for (const first of [opts.preferred, opts.pinned]) if (first !== undefined && order.includes(first)) order = [first, ...order.filter((s) => s !== first)];
    // Stable sort: usable first, keeping the order above within each tier.
    const ranked = order.map((s) => ({ s, t: tier(opts.accountId, s) }));
    const maxTier = maxTierOf(opts);
    return ranked.filter((r) => r.t <= maxTier).sort((a, b) => a.t - b.t);
  }

  /** Some server of the location that no other port holds is refused for the account:
   * with no pick, the location has nothing left but servers that refused it. */
  function freeRefusedExists(opts: SelectOptions): boolean {
    return opts.target.servers.some((s) => health.isRefused(opts.accountId, s) && !heldBy(opts.target.providerId, identityOf(s), opts.portKey));
  }

  /**
   * Picks a server for a port (spec §6.8): free (no other enabled port of the provider
   * holds the same machine, compared on resolved IP), usable for the account, best
   * first. Resolves hostnames on the way; a host that no longer resolves is marked dead.
   * Must run under `withClaimLock`, together with writing the pick to the row.
   */
  async function selectServer(opts: SelectOptions): Promise<{ pick?: ServerPick; dnsFailed: boolean; onlyRefused?: boolean }> {
    let dnsFailed = false;
    /** Candidates that turned out, once resolved, to be a machine already marked under
     * another name: tried only after every candidate of their old tier. */
    const demoted: Array<{ server: string; ip: string; t: number }> = [];
    const free = (server: string, ip: string): boolean => {
      const id = identityOf(server, ip);
      return !(opts.exclude && sameMachine(opts.exclude, id)) && !heldBy(opts.target.providerId, id, opts.portKey);
    };
    for (const { s: server, t: assumed } of orderCandidates(opts)) {
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
        noteResolved(opts.target, server, ip);
        const t = tier(opts.accountId, server);
        if (t > assumed) {
          if (t <= maxTierOf(opts)) demoted.push({ server, ip, t });
          break;
        }
        if (!free(server, ip)) continue;
        return { pick: { server, ip }, dnsFailed };
      }
    }
    for (const { server, ip } of demoted.sort((a, b) => a.t - b.t)) if (free(server, ip)) return { pick: { server, ip }, dnsFailed };
    return { dnsFailed, onlyRefused: !dnsFailed && freeRefusedExists(opts) };
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

  /** port key -> back-off attempts used since it was last online, as reported by the
   * engine's health machine. Handed back on every engine (re)start so the back-off keeps
   * growing towards 30 min instead of restarting at 30 s each time (spec §6.4). */
  const backoffAttempts = new Map<string, number>();

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

  /**
   * Leaves `key` in a terminal failure (spec §6.4): no local retry, no timer, and its
   * engine stopped, so nothing knocks on the provider's door again until the user acts.
   * The stop is deferred (callers run inside the engine's state-change callback) and
   * skipped if the user restarted the port in between.
   */
  function failTerminal(key: string, reason: FailReason, from?: Extract<PortState, { kind: 'failed' }>, detail?: FailDetail): void {
    cancelLocalRetry(key);
    const attempt = from?.attempt ?? Math.max(1, backoffAttempts.get(key) ?? 0);
    updatePort(key, { state: { kind: 'failed', reason, untilMs: from?.untilMs ?? Date.now(), attempt, ...(detail ? { detail } : {}) } });
    setTimeout(() => {
      const row = findPort(key);
      if (row && isTerminalState(row.state)) void deps.engine.stop(key).catch(() => undefined);
    }, 0);
  }

  /** Moves an enabled port off its current server if a usable free one remains for its
   * account (spec §6.8 failover). False when there is nowhere to go.
   *
   * A refusal (`refusal: true`) fails over even while a Change IP is in flight: the
   * refused server is the one the Change IP just moved the port to, and the rotate has
   * already stopped waiting on it (a `failed` state ends its wait). Leaving the port
   * there would strand it on a server that refused it while usable ones are free. */
  function failOver(key: string, reasonKey: string, opts: { refusal?: boolean } = {}): boolean {
    const port = findPort(key);
    if (!port || !port.enabled || (rotatingKeys.has(key) && !opts.refusal)) return false;
    if (!hasUsableAlternative(port, port.accountId, false)) return false;
    restartElsewhere(key, reasonKey);
    return true;
  }

  /** §4.2 "move a port on refusal": another account of the provider that may still use
   * a free server of this location (a server refused for one account may still be used
   * by another — spec §6.8). Never for files: a file IS its account. */
  function moveToAnotherAccount(key: string): boolean {
    const port = findPort(key);
    // Called only on a refusal: like `failOver`'s, it may act during a Change IP.
    if (!port || !port.enabled || !deps.pool || port.providerId === 'file') return false;
    const next = deps.pool.pickAccount(port.providerId, { exclude: port.accountId, forPortKey: key });
    if (!next || !hasUsableAlternative(port, next.id, true)) return false;
    restartElsewhere(key, 'server-refused', { accountId: next.id });
    return true;
  }

  // ── Credentials: plan refusal vs wrong password (spec §5.2) ──────────────────────

  function credentialOf(accountId: string): CredentialCheck | undefined {
    return deps.state.getState().credentials?.[accountId];
  }

  function setCredential(accountId: string, state: CredentialCheck['state']): void {
    const at = now();
    deps.state.setState((st) => {
      const prev = st.credentials?.[accountId];
      const verifiedAt = state === 'verified' ? at : prev?.verifiedAt;
      const next: CredentialCheck = { state, at, ...(verifiedAt !== undefined ? { verifiedAt } : {}) };
      return { ...st, credentials: { ...st.credentials, [accountId]: next } };
    });
  }

  /** The machine a server token stands for, as far as it is known. */
  function machineKey(server: string): string {
    return knownIp(server) ?? server;
  }

  async function runProbe(account: Account, secret: AccountSecret): Promise<CredentialVerdict> {
    const provider = deps.providers.get(account.providerId);
    if (!provider) return 'unsupported';
    try {
      const { outcome } = await credentialProbe(account, secret, provider);
      return outcome === 'ok' ? 'verified' : outcome === 'auth' ? 'rejected' : outcome === 'unsupported' ? 'unsupported' : 'unverified';
    } catch {
      return 'unverified';
    }
  }

  /** The login was checked and is wrong (a free-tier server refused it). Every refusal
   * marked since it was last verified was marked on the false assumption that it works,
   * so those go; every port of the account that is not up now fails for good. */
  function credentialsRejected(accountId: string): void {
    health.forgetRefusalsSince(accountId, credentialOf(accountId)?.verifiedAt ?? 0);
    persistHealth();
    setCredential(accountId, 'rejected');
    for (const p of deps.state.getState().ports) {
      if (p.accountId !== accountId || !p.enabled || rotatingKeys.has(p.key)) continue;
      if (p.state.kind === 'online' || p.state.kind === 'verifying') continue; // an old session still up
      failTerminal(p.key, 'auth', undefined, 'wrong-credentials');
    }
  }

  function applyVerdict(accountId: string, verdict: CredentialVerdict): void {
    if (verdict === 'verified') setCredential(accountId, 'verified');
    else if (verdict === 'rejected') credentialsRejected(accountId);
    else if (verdict === 'unverified') setCredential(accountId, 'unverified');
  }

  /** A live check of the account's STORED credentials, applied when it ends. Undefined
   * when one ran within `CREDENTIAL_PROBE_INTERVAL_MS`; joins one already in flight. */
  function verifyStoredCredentials(accountId: string): Promise<CredentialVerdict> | undefined {
    const inFlight = probesInFlight.get(accountId);
    if (inFlight) return inFlight;
    const last = lastProbeAt.get(accountId);
    if (last !== undefined && now() - last < CREDENTIAL_PROBE_INTERVAL_MS) return undefined;
    const account = deps.state.getState().accounts.find((a) => a.id === accountId);
    const secret = account && loadAccountSecret(deps.secrets, account.secretRef);
    if (!account || !secret) return undefined;
    lastProbeAt.set(accountId, now());
    const epoch = credentialEpoch.get(accountId) ?? 0;
    const current = () => (credentialEpoch.get(accountId) ?? 0) === epoch && deps.state.getState().accounts.some((a) => a.id === accountId);
    const run = runProbe(account, secret)
      .then((verdict) => {
        // Replaced (or removed) while it ran: it checked credentials that are gone.
        if (!current()) return 'unsupported' as const;
        applyVerdict(accountId, verdict);
        return verdict;
      })
      .finally(() => {
        if (probesInFlight.get(accountId) === run) probesInFlight.delete(accountId);
      });
    probesInFlight.set(accountId, run);
    return run;
  }

  function anyOnline(accountId: string, exceptKey?: string): boolean {
    return deps.state.getState().ports.some((p) => p.key !== exceptKey && p.accountId === accountId && p.state.kind === 'online');
  }

  /** The port's account demonstrably works: another of its ports is online, or it was
   * confirmed online on another server recently. */
  function accountWorksElsewhere(port: PortRow & { server: string }): boolean {
    return anyOnline(port.accountId, port.key) || health.workedRecently(port.accountId, HMA_PROVEN_WINDOW_MS, port.server);
  }

  /** Every server of the port's location has refused its account. */
  function locationRefusesAll(port: PortRow): boolean {
    const target = portTargets.get(port.key);
    return Boolean(target && target.servers.length > 0 && target.servers.every((s) => health.isRefused(port.accountId, s)));
  }

  /** A server outside the account's plan refused it (the login itself works): mark it
   * (7 days, per machine) and move on; with nowhere left, `failed(not-in-plan)`. */
  function planRefusal(port: PortRow & { server: string }, state: Extract<PortState, { kind: 'failed' }>): void {
    health.markRefused(port.accountId, port.server);
    persistHealth();
    if (failOver(port.key, 'server-not-in-plan', { refusal: true })) return;
    if (moveToAnotherAccount(port.key)) return;
    failTerminal(port.key, 'not-in-plan', state, locationRefusesAll(port) ? 'location-not-in-plan' : undefined);
    // Verified a while ago, and nothing of the account is up: the password may have been
    // changed since. Check again (throttled) before blaming the plan for good — but not
    // when a server accepted the login moments ago (a Change IP off a working server).
    const verifiedAt = credentialOf(port.accountId)?.verifiedAt;
    const verifiedJustNow = verifiedAt !== undefined && now() - verifiedAt < CREDENTIAL_PROBE_INTERVAL_MS;
    if (!anyOnline(port.accountId) && !verifiedJustNow) void verifyStoredCredentials(port.accountId);
  }

  /** No free-tier server could be reached, so nothing is known (spec §5.2, last resort):
   * the server is only marked dead (2 h, not a 7-day refusal) and the port moves on;
   * after refusals on 3 distinct servers with nothing online the walk stops, saying the
   * login could not be verified — never that the password is wrong. */
  function unverifiedRefusal(port: PortRow & { server: string }, state: Extract<PortState, { kind: 'failed' }>): void {
    if (refusals.suspectsBadLogin(port.accountId)) return failTerminal(port.key, 'auth', state, 'unverified-login');
    health.markDead(port.accountId, port.server);
    if (!failOver(port.key, 'server-refused', { refusal: true })) failTerminal(port.key, 'auth', state, 'unverified-login');
  }

  /** A `failed(auth)` from the engine (spec §5.1, §5.2, §6.8 "server refused"). Every
   * outcome either moves the port to another server or leaves it terminally failed. */
  function onAuthFailure(port: PortRow & { server: string }, state: Extract<PortState, { kind: 'failed' }>): void {
    if (port.providerId === 'hma') {
      // §5.1: device creds, per-server tenant — but a refusal only once the creds are
      // known to work somewhere; otherwise (stale or revoked device creds) walking the
      // pool would just mark every server refused for a week.
      if (!accountWorksElsewhere(port)) return failTerminal(port.key, 'auth', state);
      health.markRefused(port.accountId, port.server);
      persistHealth();
      if (failOver(port.key, 'server-refused', { refusal: true })) return;
      if (moveToAnotherAccount(port.key)) return;
      return failTerminal(port.key, 'auth', state);
    }
    // No free-tier server to tell a wrong password from a plan refusal: it is the login.
    if (!freeTierProviders.get(port.providerId)) return failTerminal(port.key, 'auth', state);

    refusals.recordAuthFailure(port.accountId, machineKey(port.server));
    const check = credentialOf(port.accountId);
    if (check?.state === 'verified' || anyOnline(port.accountId, port.key)) return planRefusal(port, state);
    if (check?.state === 'rejected') return failTerminal(port.key, 'auth', state, 'wrong-credentials');

    // Unknown or unverified: ask a free-tier server (at most once per 10 min per account).
    const verdict = verifyStoredCredentials(port.accountId);
    if (!verdict) return unverifiedRefusal(port, state);
    const { key, server } = port;
    cancelLocalRetry(key);
    updatePort(key, { state: { kind: 'retrying', untilMs: Date.now() + CREDENTIAL_PROBE_BUDGET_MS, attempt: state.attempt, reasonKey: 'checking-sign-in' } });
    const waiting = findPort(key)?.state;
    // Nothing runs for the port meanwhile: its engine is stopped (after this callback).
    setTimeout(() => {
      if (findPort(key)?.state === waiting) void deps.engine.stop(key).catch(() => undefined);
    }, 0);
    void verdict.then((v) => {
      const row = findPort(key);
      // Stopped, removed, restarted or moved meanwhile: that path owns the port now.
      if (!row || !row.enabled || row.state !== waiting || row.server !== server) return;
      const pinned = row as PortRow & { server: string };
      if (v === 'verified') planRefusal(pinned, state);
      else if (v === 'unverified') unverifiedRefusal(pinned, state);
      // The credentials were replaced while the check ran: try again with the new ones.
      else if (v === 'unsupported') restartElsewhere(key, 'credentials-changed');
      // 'rejected': `credentialsRejected` has already failed every port of the account.
    });
  }

  // Bookkeeping for `onConnectivityFailure` (spec §6.4 "a port's exit IP is sticky").
  /** Ports that have reached `online` since their last (re)start. */
  const onlineSinceStart = new Set<string>();
  /** port key -> the server it was last online on. */
  const lastOnlineServer = new Map<string, string>();
  /** port key -> failed fresh reconnects in a row to its `lastOnlineServer`. */
  const stickyFailures = new Map<string, number>();
  /** Connectivity failures within the last `CORRELATED_DROP_WINDOW_MS`. */
  let recentFailures: Array<{ key: string; providerId: ProviderId; at: number }> = [];
  /** Provider (or '*' for the whole host) -> epoch ms its incident holds until. */
  const incidentUntil = new Map<ProviderId | '*', number>();

  /**
   * A connectivity failure (`retrying` timeout/unreachable/exited/verify-failed) of a
   * pinned port (spec §6.4, §6.8). The rule, in order:
   *
   * 1. Correlated: if another port of the same provider failed within the last 15 s,
   *    that provider has an incident; if ports of two providers did, the host has one
   *    (its network or uplink dropped). During an incident (2 min, extended by every
   *    further failure) nothing is marked and no port moves: `PortHealth`'s back-off
   *    retries each port on its SAME server.
   * 2. A drop of a port that had reached `online` since its last start marks nothing
   *    either: the retry reconnects to the same server, keeping the exit IP.
   * 3. Only a failed fresh reconnect condemns a server: it is marked dead (2 h) and the
   *    port fails over. For the server the port was last online on, that takes
   *    `STICKY_RECONNECT_FAILURES` failed reconnects in a row; a server the port never
   *    got online on (a new pin, a failover target) is condemned at once.
   */
  function onConnectivityFailure(port: PortRow & { server: string }): ProviderId | '*' | undefined {
    const at = now();
    const wasOnline = onlineSinceStart.delete(port.key);
    recentFailures = recentFailures.filter((f) => at - f.at < CORRELATED_DROP_WINDOW_MS && f.key !== port.key);
    const others = recentFailures;
    recentFailures = [...others, { key: port.key, providerId: port.providerId, at }];
    if (others.some((f) => f.providerId === port.providerId)) incidentUntil.set(port.providerId, at + INCIDENT_HOLD_MS);
    if (others.some((f) => f.providerId !== port.providerId)) incidentUntil.set('*', at + INCIDENT_HOLD_MS);
    const scope = (incidentUntil.get('*') ?? 0) > at ? '*' : (incidentUntil.get(port.providerId) ?? 0) > at ? port.providerId : undefined;
    if (scope !== undefined) {
      incidentUntil.set(scope, at + INCIDENT_HOLD_MS);
      return scope;
    }
    if (wasOnline) return undefined;
    if (lastOnlineServer.get(port.key) === port.server) {
      const failures = (stickyFailures.get(port.key) ?? 0) + 1;
      stickyFailures.set(port.key, failures);
      if (failures < STICKY_RECONNECT_FAILURES) return undefined;
    }
    stickyFailures.delete(port.key);
    health.markDead(port.accountId, port.server);
    // A WireGuard port does not jump to the next server at once: that would be another
    // silent handshake seconds after the last one. Its back-off retry re-selects, and the
    // dead mark moves it then (spec §6.4 "Provider safety").
    if (!isWireguard(port.accountId)) failOver(port.key, 'server-dead');
    return undefined;
  }

  /** Ports that completed a handshake (`verifying` or `online`) since their last start. */
  const handshookSinceStart = new Set<string>();

  /** Shows `failed(key-rejected)`: no timer, nothing retries until the user acts. */
  function markKeyRejected(key: string): void {
    cancelLocalRetry(key);
    const attempt = Math.max(1, backoffAttempts.get(key) ?? 0);
    updatePort(key, { state: { kind: 'failed', reason: 'key-rejected', untilMs: Date.now(), attempt } });
  }

  /** The account's key got no handshake on too many attempts: stop every one of its
   * ports (their engines too, so nothing keeps knocking) and leave them failed.
   * Deferred: runs from inside the engine's state-change callback. */
  function lockAccount(accountId: string): void {
    setTimeout(() => {
      for (const p of deps.state.getState().ports) {
        if (p.accountId !== accountId || !p.enabled || rotatingKeys.has(p.key)) continue;
        cancelLocalRetry(p.key);
        void deps.engine
          .stop(p.key)
          .catch(() => undefined)
          .then(() => {
            // Still locked, still this account's, and not stopped by the user meanwhile.
            const row = findPort(p.key);
            if (row?.enabled && row.accountId === accountId && wgGuard.isLocked(accountId)) markKeyRejected(p.key);
          });
      }
    }, 0);
  }

  /** WireGuard bookkeeping for one engine state change (spec §6.4 "Provider safety"). */
  function trackHandshakes(port: PortRow, state: PortState, incident: ProviderId | '*' | undefined): void {
    if (!isWireguard(port.accountId)) return;
    if (state.kind === 'verifying' || state.kind === 'online') {
      // WireGuard reaches `verifying` on its first /delay 200: the handshake completed.
      handshookSinceStart.add(port.key);
      const wasLocked = wgGuard.isLocked(port.accountId);
      wgGuard.recordHandshake(port.accountId);
      if (wasLocked) persistLockouts();
      return;
    }
    if (state.kind !== 'retrying' || !NO_HANDSHAKE_REASONS.has(state.reasonKey)) return;
    // A drop after a handshake, or the whole host losing its network, says nothing about the key.
    if (handshookSinceStart.has(port.key) || incident === '*') return;
    const proven = health.workedRecently(port.accountId, Number.POSITIVE_INFINITY);
    if (wgGuard.recordNoHandshake(port.accountId, proven)) {
      persistLockouts();
      lockAccount(port.accountId);
    }
  }

  /** The exit-IP probe is the invariant's final check (spec §6.8): a port whose exit IP
   * equals another enabled port's of the same provider moves to another server. */
  function onOnline(port: PortRow & { server: string }, exitIp: string): void {
    const serverIp = port.serverIp ?? knownIp(port.server);
    // A session exit (NordVPN) is the tunnel's, not the server's: remembered as the
    // server's identity, a stale one could make another server look like this machine
    // once its own session drew that exit. Its live value still counts below.
    if (serverIp && EXIT_IP_MODELS[port.providerId] !== 'session') exitByIp.set(serverIp, exitIp);
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
  // `retrying` = possibly dead (see `onConnectivityFailure`), a `failed(auth)` = possibly
  // refused (see `authVerdict`).
  /** port key -> `since` of the online state last handled, to tell a latency refresh of
   * the same online stretch from a new transition. */
  const handledOnline = new Map<string, number>();

  deps.engine.onStateChange((key, state) => {
    if (isProbeKey(key)) return; // a credential probe (credential-probe.ts), not a port
    updatePort(key, { state });
    if (state.kind === 'retrying' || state.kind === 'failed') backoffAttempts.set(key, state.attempt);
    else if (state.kind === 'online') backoffAttempts.delete(key);
    // An online port's periodic latency refresh is not a transition: nothing to learn.
    if (state.kind === 'online' && handledOnline.get(key) === state.since) return;
    if (state.kind === 'online') handledOnline.set(key, state.since);
    else handledOnline.delete(key);
    const port = findPort(key);
    if (!port?.server) return;
    const pinned = port as PortRow & { server: string };

    if (state.kind === 'online') {
      health.markOk(port.accountId, port.server);
      persistHealth();
      // A server accepted the login: the credentials are right (spec §5.2).
      if (freeTierProviders.get(port.providerId)) setCredential(port.accountId, 'verified');
    }
    if (port.providerId === 'zoogvpn') {
      if (state.kind === 'online') refusals.recordOnline(port.accountId, machineKey(port.server));
      else refusals.clearOnline(port.accountId, machineKey(port.server));
    }

    let incident: ProviderId | '*' | undefined;
    if (state.kind === 'online') {
      returnTo.delete(key);
      onlineSinceStart.add(key);
      lastOnlineServer.set(key, port.server);
      stickyFailures.delete(key);
      onOnline(pinned, state.exitIp);
    } else if (state.kind === 'retrying' && CONNECTIVITY_RETRY_REASONS.has(state.reasonKey)) {
      incident = onConnectivityFailure(pinned);
    } else if (state.kind === 'failed' && state.reason === 'auth') {
      onAuthFailure(pinned, state);
    }
    trackHandshakes(port, state, incident);
    if (port.providerId === 'zoogvpn') persistRefusals();
  });

  // §6.4 health-driven retry: when a port's back-off elapses, re-run `startPort` rather
  // than letting the engine respawn its stale config in place (reviewer I-1): the start
  // path re-resolves and re-selects, so a dead server fails over (spec §6.8). A rotate
  // in flight already does its own stop+start, so skip the retry then.
  deps.engine.onRetryDue?.((key) => {
    if (isProbeKey(key) || rotatingKeys.has(key)) return;
    const row = findPort(key);
    if (row && isTerminalState(row.state)) return; // terminal: only the user restarts it
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

  async function startPort(key: string, opts: StartOptions = {}): Promise<void> {
    if (opts.user) backoffAttempts.delete(key);
    try {
      const s = deps.state.getState();
      const port = s.ports.find((p) => p.key === key);
      // Removed, or renamed by a Change IP to another city, since this start was due:
      // nothing to start, and nothing to retry (a retry would only find it gone again).
      if (!port) return;
      // A terminal failure waits for the user (or new credentials), whatever asked.
      const mayRetryTerminal = opts.user === true || opts.retryTerminal === true;
      if (isTerminalState(port.state) && !mayRetryTerminal) return;
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

      // A WireGuard key the app stopped retrying (spec §6.4 "Provider safety"): only a
      // user Start tries again, and only once.
      if (isWireguardAccount(account, secret)) {
        if (opts.user && wgGuard.isLocked(account.id)) {
          wgGuard.rearm(account.id);
          persistLockouts();
        }
        if (wgGuard.isLocked(account.id)) {
          updatePort(key, { enabled: true });
          markKeyRejected(key);
          return;
        }
      }

      const targets = await provider.targets(account);
      freeTierProviders.set(provider.id, freeHosts(targets).length > 0);
      const target = targets.find((t) => t.key === port.locationKey);
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
        const result = await selectServer({
          target,
          accountId: fresh.accountId,
          portKey: key,
          mode: 'restart',
          pinned: fresh.server,
          // Forced off its server (refused, dead): back to where it was before a Change
          // IP, else where it was last online, before any untried server.
          preferred: returnTo.get(key) ?? lastOnlineServer.get(key),
          allowRefused: mayRetryTerminal,
        });
        if (stoppedMeanwhile()) return undefined; // stopped while resolving
        // Claimed together with `enabled`, so the next selection already sees it held.
        const { pick } = result;
        if (!pick) updatePort(key, { enabled: true });
        else if (pick.server !== fresh.server || pick.ip !== fresh.serverIp) updatePort(key, { enabled: true, ...onNewServer(pick.server, pick.ip) });
        else updatePort(key, { enabled: true, server: pick.server, serverIp: pick.ip });
        return result;
      });
      if (!selected) return; // removed or stopped meanwhile
      if (!selected.pick) {
        // Nothing free but servers that refused the account: retrying cannot help.
        if (selected.onlyRefused) return failTerminal(key, port.providerId === 'zoogvpn' ? 'not-in-plan' : 'auth');
        failWithRetry(key, selected.dnsFailed ? { kind: 'retrying', reasonKey: 'dns-failed' } : { kind: 'failed', reason: 'no-server' });
        return;
      }

      const endpoint = provider.bind(target, selected.pick.ip, account, secret);
      // Over the account's attempt budget: wait for the next token rather than knock on
      // the provider's door again now. Not a failure, so the back-off does not grow.
      const accountId = findPort(key)?.accountId ?? port.accountId;
      const waitMs = limiter.take(accountId);
      if (waitMs > 0) {
        updatePort(key, { state: { kind: 'retrying', untilMs: Date.now() + waitMs, attempt: Math.max(1, backoffAttempts.get(key) ?? 0), reasonKey: 'rate-limited' } });
        armLocalRetry(key, waitMs);
        return;
      }
      const renderInput = buildRenderInput(findPort(key) ?? port, endpoint);
      onlineSinceStart.delete(key); // a fresh (re)connect from here on
      handshookSinceStart.delete(key);
      try {
        await deps.engine.start(key, renderInput, { attempt: backoffAttempts.get(key) ?? 0 });
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
    returnTo.delete(key);
    backoffAttempts.delete(key);
    await deps.engine.stop(key);
    updatePort(key, { enabled: false, state: { kind: 'stopped' } });
    syncAutoRotate();
  }

  async function removePort(key: string): Promise<void> {
    cancelLocalRetry(key);
    returnTo.delete(key);
    lastOnlineServer.delete(key);
    backoffAttempts.delete(key);
    portTargets.delete(key);
    await deps.engine.stop(key).catch(() => undefined);
    deps.state.setState((s) => ({ ...s, ports: s.ports.filter((p) => p.key !== key) }));
    syncAutoRotate();
  }

  /** Change IP (spec §6.5): restarts only this port on another server, then confirms
   * the exit IP actually changed before reporting success. */
  async function rotatePort(key: string, toServer?: string, opts: StartOptions = {}): Promise<RotateResult> {
    if (rotatingKeys.has(key)) return { changed: false, noteKey: 'rotate-in-progress' };
    if (opts.user) backoffAttempts.delete(key);
    rotatingKeys.add(key);
    // The row the user is looking at may be renamed partway (same-country fallback);
    // any throw after that must be attributed to the new key (reviewer round 3, item 2).
    const effectiveKey: RotateKeys = { current: key, released: false };
    try {
      return await doRotate(key, toServer, effectiveKey, opts);
    } catch (err) {
      failWithRetry(effectiveKey.current, { kind: 'retrying', reasonKey: 'rotate-error' });
      throw err;
    } finally {
      releaseRotate(key, effectiveKey);
      syncAutoRotate();
    }
  }

  /** The keys a Change IP locks: the port's, and the one it is renamed to. */
  interface RotateKeys {
    current: string;
    /** Unlocked early (`releaseRotate`): a later Change IP may hold the keys now. */
    released: boolean;
  }

  function releaseRotate(key: string, keys: RotateKeys): void {
    if (keys.released) return;
    keys.released = true;
    rotatingKeys.delete(key);
    rotatingKeys.delete(keys.current);
  }

  /** A Change IP within `target` is leaving `from`: remember it as the way back. */
  function rememberReturn(key: string, target: Target, from: string | undefined): void {
    if (from !== undefined && target.servers.includes(from)) returnTo.set(key, from);
    else returnTo.delete(key);
  }

  interface RotateClaim {
    target: Target;
    pick: ServerPick;
    account: Account;
    finalKey: string;
    fellBackToAnotherCity: boolean;
  }

  async function doRotate(key: string, toServer: string | undefined, effectiveKey: RotateKeys, opts: StartOptions): Promise<RotateResult> {
    const s = deps.state.getState();
    const port = s.ports.find((p) => p.key === key);
    if (!port) return { changed: false, noteKey: 'no-server' };
    if (!port.enabled) return { changed: false, noteKey: 'port-disabled' }; // never (re)start a disabled port
    const account = s.accounts.find((a) => a.id === port.accountId);
    const provider = account && deps.providers.get(port.providerId);
    if (!account || !provider) return { changed: false, noteKey: 'no-server' };
    // Distinct from "no-server" (reviewer item 10): it's the stored credential that
    // couldn't be read back.
    const secret = loadAccountSecret(deps.secrets, account.secretRef);
    if (!secret) return { changed: false, noteKey: 'decrypt-failed' };
    if (isWireguardAccount(account, secret) && wgGuard.isLocked(account.id)) {
      // The Change-IP button re-arms a stopped key for one attempt; automation never does.
      if (!opts.user) return { changed: false, noteKey: 'key-rejected' };
      wgGuard.rearm(account.id);
      persistLockouts();
    }
    // Auto-rotate and the webhook never revive a terminally failed port; the button does.
    if (isTerminalState(port.state) && !opts.user) return { changed: false, noteKey: 'needs-attention' };
    // A Change IP is a handshake attempt like any other (spec §6.4 "Provider safety").
    if (limiter.take(account.id) > 0) return { changed: false, noteKey: 'rate-limited' };

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
    freeTierProviders.set(provider.id, freeHosts(targets).length > 0);
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
        noteResolved(currentTarget, toServer, ip);
        if (!health.isUsable(fresh.accountId, toServer)) return { noteKey: 'server-unavailable' }; // another name of a marked machine
        if (heldBy(fresh.providerId, identityOf(toServer, ip), key)) return { noteKey: 'server-unavailable' };
        rememberReturn(key, currentTarget, fresh.server);
        updatePort(key, onNewServer(toServer, ip));
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
          rememberReturn(key, currentTarget, fresh.server);
          updatePort(key, onNewServer(pick.server, pick.ip));
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
        returnTo.delete(key); // its old server is in another location now
        // Rename NOW, before the engine is told about it (reviewer item 2): a state event
        // fired for `finalKey` must find its row. The old key's `online` must not carry
        // over: nothing reports for that key any more once it is renamed.
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
                  ...onNewServer(pick.server, pick.ip),
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
    onlineSinceStart.delete(key);
    onlineSinceStart.delete(finalKey);
    handshookSinceStart.delete(key);
    handshookSinceStart.delete(finalKey);
    const attempt = backoffAttempts.get(key) ?? 0;
    backoffAttempts.delete(key);
    if (attempt > 0) backoffAttempts.set(finalKey, attempt);
    await deps.engine.start(finalKey, renderInput, { attempt });

    // Wait for `PortHealth` to confirm the tunnel before probing (reviewer item 1).
    const reachedOnline = await waitForOnlineOrTimeout(finalKey, rotateOnlineTimeoutMs);
    if (!reachedOnline && !fellBackToAnotherCity && health.isRefused(claim.account.id, pick.server)) {
      return settleAfterRefusal(key, effectiveKey, { refused: pick.server, previous: port.server, beforeIp, beforeIpUnverifiable, auth, proxyPort: port.proxyPort });
    }
    let afterIp: string | undefined;
    if (reachedOnline) {
      try {
        afterIp = (await deps.exitIp.probe(port.proxyPort, auth)).ip;
      } catch {
        afterIp = undefined;
      }
    }

    const changed = !beforeIpUnverifiable && beforeIp !== undefined && afterIp !== undefined && afterIp !== beforeIp;
    // A move to another city is reported whatever the IP check says: the row now lives
    // in another location's group, and that must never go unnoticed.
    if (fellBackToAnotherCity) return { changed, from: beforeIp, to: afterIp, noteKey: 'rotated-to-another-city', movedTo: target.city };
    const noteKey = beforeIpUnverifiable
      ? 'not-verified'
      : changed
        ? undefined
        : !reachedOnline
          ? 'online-timeout'
          : afterIp === undefined
            ? 'probe-failed'
            : 'exit-ip-unchanged';

    return { changed, from: beforeIp, to: afterIp, noteKey };
  }

  /**
   * The server a Change IP moved the port to refused its account (spec §6.5, §6.8): the
   * refusal path has marked it and is moving the port on, back to the server it came
   * from when that is still usable, else to the next free usable one; it fails for good
   * only with none left. Waits for where it lands and says so. The rotate lock is
   * released first: what runs now is ordinary failover, whose own retries must not be
   * held back by it.
   */
  async function settleAfterRefusal(
    key: string,
    keys: RotateKeys,
    ctx: {
      refused: string;
      previous?: string;
      beforeIp?: string;
      beforeIpUnverifiable: boolean;
      auth?: { username: string; password: string };
      proxyPort: number;
    },
  ): Promise<RotateResult> {
    const finalKey = keys.current;
    releaseRotate(key, keys);
    const deadline = Date.now() + rotateOnlineTimeoutMs;
    let online = false;
    for (;;) {
      const row = findPort(finalKey);
      if (!row || !row.enabled || isTerminalState(row.state)) break;
      if (row.state.kind === 'online') {
        online = true;
        break;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      // A `failed` that is not terminal (another refusal, moving on again) waits once more.
      if (await waitForOnlineOrTimeout(finalKey, left)) {
        online = true;
        break;
      }
    }
    const landedOn = online ? findPort(finalKey)?.server : undefined;
    let afterIp: string | undefined;
    if (landedOn !== undefined) {
      try {
        afterIp = (await deps.exitIp.probe(ctx.proxyPort, ctx.auth)).ip;
      } catch {
        afterIp = undefined;
      }
    }
    const changed = !ctx.beforeIpUnverifiable && ctx.beforeIp !== undefined && afterIp !== undefined && afterIp !== ctx.beforeIp;
    const noteKey = landedOn === undefined ? 'server-refused' : landedOn === ctx.previous ? 'server-refused-returned' : 'server-refused-moved';
    return {
      changed,
      ...(ctx.beforeIp !== undefined ? { from: ctx.beforeIp } : {}),
      ...(afterIp !== undefined ? { to: afterIp } : {}),
      noteKey,
      refusedServer: ctx.refused,
      ...(landedOn !== undefined ? { landedOn } : {}),
    };
  }

  /** hostname -> its resolution for `listServers` in flight, shared by concurrent calls. */
  const listResolving = new Map<string, Promise<void>>();

  /** Resolves the location's hostnames not resolved yet this session, so their marks and
   * holders are known (§6.8: a mark belongs to the machine). Never marks anything: a
   * failure only leaves the hostname unresolved. Bounded by `listResolveTimeoutMs`; a
   * lookup still running after that keeps going and is used next time. */
  async function resolveForListing(target: Target): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const server of target.servers) {
      if (isIP(server) || isPoolHostname(target, server) || resolvedIp.has(server)) continue;
      let p = listResolving.get(server);
      if (!p) {
        p = resolveServer(server)
          .then(
            (ip) => {
              if (isIP(ip)) noteResolved(target, server, ip);
            },
            () => undefined,
          )
          .finally(() => listResolving.delete(server));
        listResolving.set(server, p);
      }
      pending.push(p);
    }
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.listResolveTimeoutMs ?? 2000);
      timer.unref?.();
    });
    await Promise.race([Promise.all(pending), timeout]);
    clearTimeout(timer);
  }

  async function listServers(target: Target, portKey?: string): Promise<ServerInfo[]> {
    await resolveForListing(target);
    return serverInfos(target, portKey);
  }

  /** `listServers` on what is known now, without touching the network. */
  function serverInfos(target: Target, portKey?: string): ServerInfo[] {
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
        ...(target.freeTierServers?.includes(server) ? { freeTier: true } : {}),
      };
    });
  }

  function locationNotInPlan(target: Target): boolean {
    const accounts = deps.state.getState().accounts.filter((a) => a.providerId === target.providerId);
    if (accounts.length === 0 || target.servers.length === 0) return false;
    return target.servers.every((server) => accounts.every((a) => health.isRefused(a.id, server)));
  }

  function freeServerCount(target: Target): number {
    // A pool hostname held by a port still counts: its next answer may be another server.
    return serverInfos(target).filter(
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
    wgGuard.forget(accountId);
    wgAccounts.delete(accountId);
    // A check of the old credentials says nothing about the new ones, and one still in
    // flight must not be applied to them.
    credentialEpoch.set(accountId, (credentialEpoch.get(accountId) ?? 0) + 1);
    probesInFlight.delete(accountId);
    lastProbeAt.delete(accountId);
    deps.state.setState((st) => {
      if (!st.credentials?.[accountId]) return st;
      const { [accountId]: _dropped, ...rest } = st.credentials;
      return { ...st, credentials: rest };
    });
    persistHealth();
    persistRefusals();
    persistLockouts();
  }

  async function checkCredentials(account: Account, secret: AccountSecret): Promise<CredentialVerdict> {
    const verdict = await runProbe(account, secret);
    // A probe ran, so the provider has a free tier — unless it checked on an ordinary
    // server of a provider without plans (ExpressVPN), where an auth failure is the login.
    if (verdict !== 'unsupported' && !deps.providers.get(account.providerId)?.anyServerChecksLogin) freeTierProviders.set(account.providerId, true);
    return verdict;
  }

  function recordCredentialCheck(accountId: string, verdict: CredentialVerdict): void {
    if (verdict === 'unsupported') return;
    lastProbeAt.set(accountId, now());
    if (verdict === 'rejected') credentialsRejected(accountId);
    else setCredential(accountId, verdict);
  }

  return {
    startPort,
    stopPort,
    removePort,
    rotatePort,
    addPort,
    listServers,
    freeServerCount,
    locationNotInPlan,
    setAutoRotate,
    exportPorts,
    testPort,
    syncAutoRotate,
    stopAutoRotate: () => autoRotate.stopAll(),
    credentialsChanged,
    checkCredentials,
    recordCredentialCheck,
  };
}
