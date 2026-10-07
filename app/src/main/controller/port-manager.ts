import { networkInterfaces } from 'node:os';
import type { AccountSecret, ExportFormat, FailReason, PortRow, PortState, RenderInput, RotateResult, Target } from '../../shared/contracts';
import { createRefusalTracker, type RefusalTracker } from '../accounts/refusals';
import { createAutoRotateScheduler, type AutoRotateScheduler } from './auto-rotate';
import { nextBackoffMs } from '../health/backoff';
import type { SecretStore } from '../store/secrets';
import type { StateStore } from '../store/state';
import { exportLines, type ExportCreds } from './export-format';
import { PortInUseError, type Engine, type ExitIpProber, type PortAllocator, type ProviderRegistry } from './ports';

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
   * ZoogVPN plan-refusal-vs-login tracker (spec §5.2, reviewer item 9). @default a
   * fresh tracker seeded from `AppState.refusals` (so it survives an app restart) — the
   * same instance should also be handed to `accounts/pool.ts`'s `createAccountPool` so
   * `pickAccount`/`moveOnRefusal` see the same memory this module writes to.
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
   * a pre-flight `port-in-use`, or an unexpected exception during `startPort`/
   * `rotatePort`). Injectable for tests. @default real `setTimeout`-based. */
  scheduleRetry?: (ms: number, cb: () => void) => () => void;
  /** Injectable for deterministic backoff-jitter tests. @default `Math.random`. */
  backoffRng?: () => number;
}

export interface PortManager {
  startPort(key: string): Promise<void>;
  stopPort(key: string): Promise<void>;
  removePort(key: string): Promise<void>;
  rotatePort(key: string): Promise<RotateResult>;
  setAutoRotate(key: string, minutes: number): Promise<void>;
  exportPorts(keys: string[], format: ExportFormat): Promise<string>;
  testPort(key: string, speed: boolean): Promise<{ ok: boolean; exitIp?: string; latencyMs?: number; mbps?: number }>;
  /**
   * Not in the dispatch's named list, but needed to go from a bare `Target.key` (what
   * `listTargets()` returns before any port row exists) to a persisted `PortRow` with an
   * allocated, restart-stable `proxyPort` (§6.2). The IPC layer's `startPorts` calls this
   * for any key that has no row yet, then calls `startPort`. Calls are serialized
   * (reviewer item 5) so two concurrent `ensurePort`s never race onto the same port.
   */
  ensurePort(target: Target, accountId: string): Promise<PortRow>;
  /** Reconciles auto-rotate timers against the CURRENT `ports` (reviewer item 8). Called
   * internally after start/stop/remove/setAutoRotate/rotate already — exported mainly so
   * the integrator can call it once at app startup with the rows loaded from disk
   * (nothing in this module runs until something calls a method on it). */
  syncAutoRotate(): void;
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

/** Picks the next server in round-robin order, skipping `current` (reviewer item 10):
 * with >= 2 servers this always returns a different one; with 0 or 1 it returns
 * `undefined` (there is no "other" IP at this location). */
function nextServerRoundRobin(servers: string[], current: string | undefined): string | undefined {
  if (servers.length < 2) return undefined;
  const idx = current ? servers.indexOf(current) : -1;
  const next = servers[(idx + 1) % servers.length];
  return next === current ? undefined : next;
}

/** How long `rotatePort` waits for the restarted port to reach `online` before giving
 * up on confirming the new exit IP (reviewer item 1). */
const DEFAULT_ROTATE_ONLINE_TIMEOUT_MS = 45_000;

function defaultScheduleRetry(ms: number, cb: () => void): () => void {
  const timer = setTimeout(cb, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createPortManager(deps: PortManagerDeps): PortManager {
  const getLanIPv4 = deps.getLanIPv4 ?? firstLanIPv4;
  const refusals = deps.refusals ?? createRefusalTracker({ initial: deps.state.getState().refusals });
  const rotateOnlineTimeoutMs = deps.rotateOnlineTimeoutMs ?? DEFAULT_ROTATE_ONLINE_TIMEOUT_MS;
  const scheduleRetryFn = deps.scheduleRetry ?? defaultScheduleRetry;
  const backoffRng = deps.backoffRng ?? Math.random;
  // §4.2/§6.5 auto-rotate timers (reviewer item 8): this module owns syncing them —
  // callers (IPC layer, webhook, the real engine via `rotatePort`) never have to
  // remember to do it themselves.
  const autoRotate = deps.autoRotate ?? createAutoRotateScheduler({ rotate: (k) => rotatePort(k) });

  function persistRefusals(): void {
    deps.state.setState((st) => ({ ...st, refusals: refusals.serialize() }));
  }

  // `PortHealth` (inside the real `Engine`) OWNS `PortRow.state` from here on — this is
  // the one and only place port-manager writes a connecting/verifying/online/retrying
  // transition driven by the engine's own lifecycle (reviewer item 6). The handful of
  // pre-flight terminal states below (no account/provider/secret/target, or a
  // `PortInUseError` before the engine ever got involved) are set directly, since
  // `PortHealth` was never engaged for them.
  //
  // The same callback also feeds the ZoogVPN plan-refusal-vs-login tracker (spec §5.2,
  // reviewer item 9): `online` records the (account, server) as live evidence; anything
  // else clears that evidence (it is no longer proof the account works); a terminal
  // `failed(auth)` additionally records an auth failure for that pair. Persisted back to
  // `AppState.refusals` on every change so it survives a restart.
  deps.engine.onStateChange((key, state) => {
    updatePort(key, { state });
    const port = findPort(key);
    if (!port || port.providerId !== 'zoogvpn') return;
    if (state.kind === 'online') {
      refusals.recordOnline(port.accountId, key);
    } else {
      refusals.clearOnline(port.accountId, key);
      if (state.kind === 'failed' && state.reason === 'auth') {
        refusals.recordAuthFailure(port.accountId, key);
      }
    }
    persistRefusals();
  });

  // Serializes port-allocating operations so two concurrent calls never read the same
  // "ports currently in use" snapshot before either has written back (reviewer item 5).
  let allocationChain: Promise<unknown> = Promise.resolve();
  function withAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = allocationChain.then(fn, fn);
    allocationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Per-key lock so a webhook rotate, an auto-rotate tick, and a UI-triggered rotate
  // can never run concurrently against the same port (reviewer item 10).
  const rotatingKeys = new Set<string>();

  // Controller-WIDE lock (unlike `rotatingKeys`, which is per-key) guarding the
  // decide-and-claim step of a city-fallback: two DIFFERENT keys rotating at the same
  // time, both falling back within the same country, must never both claim the same alt
  // target (reviewer item 3). Everything inside it re-reads `deps.state.getState()`
  // fresh rather than trusting a snapshot taken before any `await`.
  let fallbackChain: Promise<unknown> = Promise.resolve();
  function withFallbackLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = fallbackChain.then(fn, fn);
    fallbackChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Real retry-timer bookkeeping for the handful of failures port-manager itself owns
  // (reviewer item 7): pre-flight states that never reached `PortHealth` at all (no
  // account/secret/target, a pre-flight `port-in-use`, or an unexpected exception during
  // `startPort`/`rotatePort`). `PortHealth`'s OWN `retrying`/`failed` states (reached via
  // a real engine that WAS started) already have their own real backoff timer inside
  // `engine-adapter.ts`'s `onRetryDue` — this is only for the states set directly here.
  const localRetryAttempts = new Map<string, number>();
  const localRetryCancel = new Map<string, () => void>();

  function cancelLocalRetry(key: string): void {
    localRetryCancel.get(key)?.();
    localRetryCancel.delete(key);
  }

  /** Resets the local backoff counter and cancels any pending timer — called once a
   * `startPort` hands a key off to the real engine successfully (its retry lifecycle, if
   * any, becomes `PortHealth`'s from here), and whenever the user explicitly stops or
   * removes a port (no more surprise restarts of something they turned off). */
  function clearLocalRetryAttempts(key: string): void {
    localRetryAttempts.delete(key);
    cancelLocalRetry(key);
  }

  type RetryableOutcome = { kind: 'retrying'; reasonKey: string } | { kind: 'failed'; reason: FailReason };

  /** Sets a `retrying`/`failed` state with a REAL schedule behind its countdown
   * (reviewer item 7 — the long-standing bug: `failPort` used to set `untilMs` in the
   * future but nothing ever actually fired at that time). Uses the shared backoff
   * schedule (`health/backoff.ts`'s `nextBackoffMs`: 30s, 1, 2, 4min… capped at 30min,
   * ±20% jitter) and — per spec's `giveUpAfter: 0` default — keeps retrying forever
   * unless/until the user stops or removes the port. */
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
    cancelLocalRetry(key);
    const cancel = scheduleRetryFn(delayMs, () => {
      localRetryCancel.delete(key);
      void startPort(key).catch(() => undefined);
    });
    localRetryCancel.set(key, cancel);
  }

  /** Resolves once `Engine.onStateChange` reports `online` (true) or `failed` (false)
   * for `targetKey`, or after `timeoutMs` with no verified transition at all (false) —
   * never trusts a post-restart probe before the tunnel is actually confirmed up
   * (reviewer item 1: with a real engine, `start()` returns right after spawn, long
   * before the handshake completes). */
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

  function findPort(key: string): PortRow | undefined {
    return deps.state.getState().ports.find((p) => p.key === key);
  }

  function takenProxyPorts(): Set<number> {
    return new Set(deps.state.getState().ports.map((p) => p.proxyPort));
  }

  function updatePort(key: string, patch: Partial<PortRow>): void {
    deps.state.setState((s) => ({
      ...s,
      ports: s.ports.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    }));
  }

  /**
   * Builds the sing-box render input for `port`. Enforces, independently of whatever
   * `settings.lanSharing` says, that a `0.0.0.0` listen is only ever used when a real
   * proxy username/password is set (reviewer critical item 1) — forcing back to
   * `127.0.0.1` otherwise, rather than ever producing an open proxy.
   *
   * `clash` is a placeholder, not a real allocation (reviewer item 10): the real
   * `Engine` (`engine-adapter.ts`'s `createRealEngine`) allocates its OWN clash_api port
   * + secret per spawn and unconditionally overwrites this field before rendering —
   * calling `allocator.allocateAux` here would burn a real port allocation that's
   * guaranteed to be thrown away unused.
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

  async function ensurePort(target: Target, accountId: string): Promise<PortRow> {
    return withAllocationLock(async () => {
      const existing = findPort(target.key);
      if (existing) return existing;
      const { settings } = deps.state.getState();
      const proxyPort = await deps.allocator.allocate({ preferred: settings.basePort, taken: takenProxyPorts(), base: settings.basePort });
      const row: PortRow = {
        key: target.key,
        providerId: target.providerId,
        accountId,
        label: target.label,
        country: target.country,
        city: target.city,
        proxyPort,
        enabled: false,
        state: { kind: 'queued' },
        autoRotateMin: 0,
      };
      deps.state.setState((s) => ({ ...s, ports: [...s.ports, row] }));
      return row;
    });
  }

  async function startPort(key: string): Promise<void> {
    try {
      const s = deps.state.getState();
      const port = s.ports.find((p) => p.key === key);
      if (!port) throw new Error(`startPort: unknown port ${key}`);
      const account = s.accounts.find((a) => a.id === port.accountId);
      const provider = account && deps.providers.get(port.providerId);
      if (!account || !provider) {
        updatePort(key, { enabled: false, state: { kind: 'failed', reason: 'no-server', untilMs: Date.now(), attempt: 1 } });
        return;
      }
      const secret = loadAccountSecret(deps.secrets, account.secretRef);
      if (!secret) {
        // A decrypt/read failure (e.g. a transient safeStorage issue) is not proof the
        // account's credentials are wrong — that would wrongly brand the account
        // broken. Retry instead of a terminal `failed(auth)` (reviewer minor), with a
        // real backoff timer behind it (reviewer item 7).
        updatePort(key, { enabled: true });
        failWithRetry(key, { kind: 'retrying', reasonKey: 'secret-unavailable' });
        return;
      }

      const targets = await provider.targets(account);
      const target = targets.find((t) => t.key === port.key);
      const serverIp = s.portServers[key] ?? target?.servers[0];
      if (!target || !serverIp) {
        updatePort(key, { enabled: true });
        failWithRetry(key, { kind: 'failed', reason: 'no-server' });
        return;
      }

      const endpoint = provider.bind(target, serverIp, account, secret);
      const renderInput = buildRenderInput(port, endpoint);
      // `enabled` is the only field port-manager sets directly here: the actual
      // connecting/verifying/online/retrying lifecycle is `PortHealth`'s, observed via
      // `deps.engine.onStateChange` (wired once in `createPortManager`) and persisted
      // from there (reviewer item 6).
      updatePort(key, { enabled: true });
      try {
        await deps.engine.start(key, renderInput);
      } catch (err) {
        if (err instanceof PortInUseError) {
          failWithRetry(key, { kind: 'failed', reason: 'port-in-use' });
          return;
        }
        throw err;
      }
      // Handed off to the real engine/PortHealth successfully: any PRIOR local backoff
      // (e.g. a previous secret-unavailable/start-error retry) no longer applies — from
      // here, retry/backoff is PortHealth's own (reviewer item 7).
      clearLocalRetryAttempts(key);
      deps.state.setState((st) => ({ ...st, portServers: { ...st.portServers, [key]: serverIp } }));
    } catch (err) {
      // Whatever went wrong, the row must never be left stuck in `connecting`
      // (reviewer item 7) — an unexpected throw still resolves to a retryable state,
      // with a real timer behind it this time.
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
    await deps.engine.stop(key).catch(() => undefined);
    deps.state.setState((s) => {
      const { [key]: _removed, ...portServers } = s.portServers;
      return { ...s, ports: s.ports.filter((p) => p.key !== key), portServers };
    });
    syncAutoRotate();
  }

  /** Rotate (spec §6.5): another IP of the same location -> another location in the
   * same country -> give up. Restarts only this port, then confirms the exit IP
   * actually changed before reporting success. */
  async function rotatePort(key: string): Promise<RotateResult> {
    if (rotatingKeys.has(key)) {
      // A webhook call, an auto-rotate tick, and a UI click must never overlap on the
      // same port (reviewer item 10).
      return { changed: false, noteKey: 'rotate-in-progress' };
    }
    rotatingKeys.add(key);
    try {
      const result = await doRotate(key);
      return result;
    } catch (err) {
      failWithRetry(key, { kind: 'retrying', reasonKey: 'rotate-error' });
      throw err;
    } finally {
      rotatingKeys.delete(key);
      syncAutoRotate(); // the key may have changed (city-fallback) — resync by identity
    }
  }

  async function doRotate(key: string): Promise<RotateResult> {
    const s = deps.state.getState();
    const port = s.ports.find((p) => p.key === key);
    if (!port) return { changed: false, noteKey: 'no-server' };
    if (!port.enabled) return { changed: false, noteKey: 'port-disabled' }; // never (re)start a disabled port
    const account = s.accounts.find((a) => a.id === port.accountId);
    const provider = account && deps.providers.get(port.providerId);
    if (!account || !provider) return { changed: false, noteKey: 'no-server' };
    const secret = loadAccountSecret(deps.secrets, account.secretRef);
    // Distinct from "no-server" (reviewer item 10): the target/server story is fine,
    // it's specifically the stored credential that couldn't be read back.
    if (!secret) return { changed: false, noteKey: 'decrypt-failed' };

    const auth = proxyAuthFromSettings();

    // If we don't already know the exit IP (e.g. the port isn't `online` right now),
    // establish a real baseline with a pre-rotate probe rather than treating "we have
    // no idea" as license to call anything "changed" (reviewer item 10).
    let beforeIp = port.state.kind === 'online' ? port.state.exitIp : undefined;
    let beforeIpUnverifiable = false;
    if (beforeIp === undefined) {
      try {
        beforeIp = (await deps.exitIp.probe(port.proxyPort, auth)).ip;
      } catch {
        beforeIpUnverifiable = true;
      }
    }

    const targets = await provider.targets(account);
    const currentTarget = targets.find((t) => t.key === port.key);

    // From here to the state-rename: controller-WIDE lock, re-reading state fresh
    // (reviewer item 3) — two DIFFERENT keys rotating at once, both falling back within
    // the same country, must never both claim the same alt target.
    const claim = await withFallbackLock(async () => {
      const sNow = deps.state.getState();
      if (!sNow.ports.some((p) => p.key === key)) return undefined; // removed mid-rotate
      const currentServer = sNow.portServers[key];

      let nextTarget = currentTarget;
      let nextServer = currentTarget ? nextServerRoundRobin(currentTarget.servers, currentServer) : undefined;
      let fellBackToAnotherCity = false;

      if (!nextServer) {
        // Never fall back onto a location that already has its own row (reviewer item
        // 2), and never onto one another concurrent fallback already just claimed
        // (reviewer item 3) — both checked against the FRESH `sNow`, not the `s` read
        // at the top of this function before any `await`.
        const existingKeys = new Set(sNow.ports.map((p) => p.key));
        const sameCountry = targets
          .filter((t) => t.key !== port.key && t.country === port.country && !existingKeys.has(t.key))
          .sort((a, b) => a.key.localeCompare(b.key));
        const alt = sameCountry[0];
        if (alt) {
          nextTarget = alt;
          nextServer = alt.servers[0];
          fellBackToAnotherCity = true;
        }
      }

      if (!nextTarget || !nextServer) return undefined;

      const finalKey = nextTarget.key;
      // Rename the row to `finalKey` NOW, before the engine is ever told about it
      // (reviewer item 2): starting the engine under `finalKey` first and renaming the
      // row only afterwards left a window where any state event the engine fired for
      // `finalKey` (even one fired synchronously inside `engine.start`) found no
      // matching row yet in `updatePort`'s `.map()` and was silently dropped.
      deps.state.setState((st) => {
        const { [key]: _old, ...restServers } = st.portServers;
        return {
          ...st,
          portServers: { ...restServers, [finalKey]: nextServer! },
          ports: st.ports.map((p) => {
            if (p.key !== key) return p;
            const identity =
              finalKey !== p.key ? { key: finalKey, country: nextTarget!.country, city: nextTarget!.city, label: nextTarget!.label } : {};
            return { ...p, ...identity };
          }),
        };
      });

      return { nextTarget, nextServer, fellBackToAnotherCity, finalKey };
    });

    if (!claim) {
      return { changed: false, noteKey: 'no-server' };
    }
    const { nextTarget, nextServer, fellBackToAnotherCity, finalKey } = claim;

    const endpoint = provider.bind(nextTarget, nextServer, account, secret);
    const renderInput = buildRenderInput(port, endpoint);

    // Stop the OLD key's engine process first, then start under the FINAL key (the row
    // was already renamed above, under the lock, so this is safe even if the engine
    // fires a state event the instant `start` is called).
    await deps.engine.stop(key);
    await deps.engine.start(finalKey, renderInput);

    // Wait for `PortHealth` to actually confirm the tunnel is up before trusting a
    // post-restart probe (reviewer item 1): with a real engine, `start()` returns right
    // after spawn, long before the handshake completes — probing immediately would see
    // a dead/not-ready endpoint, not the real exit IP.
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
      // Speed test (speed.cloudflare.com, §4.2) needs its own probe port, not yet
      // injected here — see the report's "Known gaps" for how to extend this.
    } catch {
      return { ok: false };
    }
  }

  return { startPort, stopPort, removePort, rotatePort, setAutoRotate, exportPorts, testPort, ensurePort, syncAutoRotate };
}
