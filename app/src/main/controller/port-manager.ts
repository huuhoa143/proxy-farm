import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { AccountSecret, ExportFormat, PortRow, RenderInput, RotateResult, Target } from '../../shared/contracts';
import { createRefusalTracker, type RefusalTracker } from '../accounts/refusals';
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

function randomToken(): string {
  return randomBytes(16).toString('hex');
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

const ROTATE_RETRY_BACKOFF_MS = 30_000;

export function createPortManager(deps: PortManagerDeps): PortManager {
  const getLanIPv4 = deps.getLanIPv4 ?? firstLanIPv4;
  const refusals = deps.refusals ?? createRefusalTracker({ initial: deps.state.getState().refusals });

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

  function failPort(key: string, reasonKey: string): void {
    updatePort(key, {
      state: { kind: 'retrying', untilMs: Date.now() + ROTATE_RETRY_BACKOFF_MS, attempt: 1, reasonKey },
    });
  }

  /**
   * Builds the sing-box render input for `port`. Enforces, independently of whatever
   * `settings.lanSharing` says, that a `0.0.0.0` listen is only ever used when a real
   * proxy username/password is set (reviewer critical item 1) — forcing back to
   * `127.0.0.1` otherwise, rather than ever producing an open proxy.
   */
  async function buildRenderInput(port: PortRow, endpoint: RenderInput['endpoint']): Promise<RenderInput> {
    const { settings } = deps.state.getState();
    const hasAuth = Boolean(settings.proxyUser && settings.proxyPass);
    const taken = new Set<number>(); // clash_api ports are ephemeral/auxiliary, not tracked in state
    const auxPort = await deps.allocator.allocateAux({ taken });
    return {
      endpoint,
      listen: {
        host: settings.lanSharing && hasAuth ? '0.0.0.0' : '127.0.0.1',
        port: port.proxyPort,
        proxyAuth: hasAuth ? { username: settings.proxyUser, password: settings.proxyPass } : undefined,
      },
      clash: { port: auxPort, secret: randomToken() },
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
        // broken. Retry instead of a terminal `failed(auth)` (reviewer minor).
        updatePort(key, { enabled: true });
        failPort(key, 'secret-unavailable');
        return;
      }

      const targets = await provider.targets(account);
      const target = targets.find((t) => t.key === port.key);
      const serverIp = s.portServers[key] ?? target?.servers[0];
      if (!target || !serverIp) {
        updatePort(key, { enabled: true, state: { kind: 'failed', reason: 'no-server', untilMs: Date.now(), attempt: 1 } });
        return;
      }

      const endpoint = provider.bind(target, serverIp, account, secret);
      const renderInput = await buildRenderInput(port, endpoint);
      // `enabled` is the only field port-manager sets directly here: the actual
      // connecting/verifying/online/retrying lifecycle is `PortHealth`'s, observed via
      // `deps.engine.onStateChange` (wired once in `createPortManager`) and persisted
      // from there (reviewer item 6).
      updatePort(key, { enabled: true });
      try {
        await deps.engine.start(key, renderInput);
      } catch (err) {
        if (err instanceof PortInUseError) {
          updatePort(key, { state: { kind: 'failed', reason: 'port-in-use', untilMs: Date.now(), attempt: 1 } });
          return;
        }
        throw err;
      }
      deps.state.setState((st) => ({ ...st, portServers: { ...st.portServers, [key]: serverIp } }));
    } catch (err) {
      // Whatever went wrong, the row must never be left stuck in `connecting`
      // (reviewer item 7) — an unexpected throw still resolves to a retryable state.
      failPort(key, 'start-error');
      throw err;
    }
  }

  async function stopPort(key: string): Promise<void> {
    await deps.engine.stop(key);
    updatePort(key, { enabled: false, state: { kind: 'stopped' } });
  }

  async function removePort(key: string): Promise<void> {
    await deps.engine.stop(key).catch(() => undefined);
    deps.state.setState((s) => {
      const { [key]: _removed, ...portServers } = s.portServers;
      return { ...s, ports: s.ports.filter((p) => p.key !== key), portServers };
    });
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
      return await doRotate(key);
    } catch (err) {
      failPort(key, 'rotate-error');
      throw err;
    } finally {
      rotatingKeys.delete(key);
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
    if (!secret) return { changed: false, noteKey: 'no-server' };

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
    const currentServer = s.portServers[key];

    let nextTarget = currentTarget;
    let nextServer = currentTarget ? nextServerRoundRobin(currentTarget.servers, currentServer) : undefined;
    let fellBackToAnotherCity = false;

    if (!nextServer) {
      // Never fall back onto a location that already has its own row (reviewer item 2):
      // that row owns its own engine process under its own key already.
      const existingKeys = new Set(s.ports.map((p) => p.key));
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

    if (!nextTarget || !nextServer) {
      return { changed: false, noteKey: 'no-server' };
    }

    const endpoint = provider.bind(nextTarget, nextServer, account, secret);
    const renderInput = await buildRenderInput(port, endpoint);
    const finalKey = nextTarget.key;

    // Stop the OLD key's engine process first, then start under the FINAL key (reviewer
    // item 2): starting under `key` and only renaming the state-store row afterwards
    // left the real process registered under a key nothing else would ever stop again.
    await deps.engine.stop(key);
    await deps.engine.start(finalKey, renderInput);

    let afterIp: string | undefined;
    try {
      afterIp = (await deps.exitIp.probe(port.proxyPort, auth)).ip;
    } catch {
      afterIp = undefined;
    }

    const changed = !beforeIpUnverifiable && beforeIp !== undefined && afterIp !== undefined && afterIp !== beforeIp;
    const noteKey = beforeIpUnverifiable
      ? 'not-verified'
      : changed
        ? fellBackToAnotherCity
          ? 'rotated-to-another-city'
          : undefined
        : afterIp === undefined
          ? 'probe-failed'
          : 'exit-ip-unchanged';

    deps.state.setState((st) => {
      const { [key]: _old, ...restServers } = st.portServers;
      return {
        ...st,
        portServers: { ...restServers, [finalKey]: nextServer! },
        ports: st.ports.map((p) => {
          if (p.key !== key) return p;
          // Identity only (key/city/country/label on a city-fallback): `state` is
          // `PortHealth`'s to set, via the `engine.start(finalKey, ...)` above
          // naturally driving it back through connecting -> verifying -> online
          // (reviewer item 6) — port-manager does not race it with its own guess here.
          const identity =
            finalKey !== p.key
              ? { key: finalKey, country: nextTarget!.country, city: nextTarget!.city, label: nextTarget!.label }
              : {};
          return { ...p, ...identity };
        }),
      };
    });

    return { changed, from: beforeIp, to: afterIp, noteKey };
  }

  async function setAutoRotate(key: string, minutes: number): Promise<void> {
    updatePort(key, { autoRotateMin: Math.max(0, Math.floor(minutes)) });
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

  return { startPort, stopPort, removePort, rotatePort, setAutoRotate, exportPorts, testPort, ensurePort };
}
