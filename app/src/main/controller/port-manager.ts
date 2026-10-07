import { randomBytes } from 'node:crypto';
import type { AccountSecret, ExportFormat, PortRow, RenderInput, RotateResult, Target } from '../../shared/contracts';
import type { SecretStore } from '../store/secrets';
import type { StateStore } from '../store/state';
import { exportLines, type ExportCreds } from './export-format';
import type { Engine, ExitIpProber, PortAllocator, ProviderRegistry } from './ports';

export interface PortManagerDeps {
  state: StateStore;
  secrets: SecretStore;
  engine: Engine;
  providers: ProviderRegistry;
  exitIp: ExitIpProber;
  allocator: PortAllocator;
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
   * for any key that has no row yet, then calls `startPort`.
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

export function createPortManager(deps: PortManagerDeps): PortManager {
  function findPort(key: string): PortRow | undefined {
    return deps.state.getState().ports.find((p) => p.key === key);
  }

  function updatePort(key: string, patch: Partial<PortRow>): void {
    deps.state.setState((s) => ({
      ...s,
      ports: s.ports.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    }));
  }

  async function buildRenderInput(port: PortRow, endpoint: RenderInput['endpoint']): Promise<RenderInput> {
    const { settings } = deps.state.getState();
    const auxPort = await deps.allocator.allocateAux();
    return {
      endpoint,
      listen: {
        host: settings.lanSharing ? '0.0.0.0' : '127.0.0.1',
        port: port.proxyPort,
        proxyAuth: settings.proxyUser ? { username: settings.proxyUser, password: settings.proxyPass } : undefined,
      },
      clash: { port: auxPort, secret: randomToken() },
    };
  }

  async function ensurePort(target: Target, accountId: string): Promise<PortRow> {
    const existing = findPort(target.key);
    if (existing) return existing;
    const { settings } = deps.state.getState();
    const proxyPort = await deps.allocator.allocate(settings.basePort);
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
  }

  async function startPort(key: string): Promise<void> {
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
      updatePort(key, { enabled: false, state: { kind: 'failed', reason: 'auth', untilMs: Date.now(), attempt: 1 } });
      return;
    }

    updatePort(key, { enabled: true, state: { kind: 'connecting', since: Date.now() } });

    const targets = await provider.targets(account);
    const target = targets.find((t) => t.key === port.key);
    const serverIp = s.portServers[key] ?? target?.servers[0];
    if (!target || !serverIp) {
      updatePort(key, { state: { kind: 'failed', reason: 'no-server', untilMs: Date.now(), attempt: 1 } });
      return;
    }

    const endpoint = provider.bind(target, serverIp, account, secret);
    const renderInput = await buildRenderInput(port, endpoint);
    const config = deps.engine.renderConfig(renderInput);
    await deps.engine.start(key, config);
    deps.state.setState((st) => ({ ...st, portServers: { ...st.portServers, [key]: serverIp } }));

    try {
      const exit = await deps.exitIp.probe(port.proxyPort);
      updatePort(key, { state: { kind: 'online', since: Date.now(), exitIp: exit.ip, country: exit.country } });
    } catch {
      updatePort(key, { state: { kind: 'retrying', untilMs: Date.now() + 30_000, attempt: 1, reasonKey: 'probe-failed' } });
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
    const s = deps.state.getState();
    const port = s.ports.find((p) => p.key === key);
    if (!port) return { changed: false, noteKey: 'no-server' };
    const account = s.accounts.find((a) => a.id === port.accountId);
    const provider = account && deps.providers.get(port.providerId);
    if (!account || !provider) return { changed: false, noteKey: 'no-server' };
    const secret = loadAccountSecret(deps.secrets, account.secretRef);
    if (!secret) return { changed: false, noteKey: 'no-server' };

    const targets = await provider.targets(account);
    const currentTarget = targets.find((t) => t.key === port.key);
    const currentServer = s.portServers[key];
    const beforeIp = port.state.kind === 'online' ? port.state.exitIp : undefined;

    let nextTarget = currentTarget;
    let nextServer = currentTarget?.servers.find((ip) => ip !== currentServer);
    let fellBackToAnotherCity = false;

    if (!nextServer) {
      const sameCountry = targets
        .filter((t) => t.key !== port.key && t.country === port.country)
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
    const config = deps.engine.renderConfig(renderInput);
    await deps.engine.stop(key);
    await deps.engine.start(key, config);

    let afterIp: string | undefined;
    let afterCountry: string | undefined;
    try {
      const exit = await deps.exitIp.probe(port.proxyPort);
      afterIp = exit.ip;
      afterCountry = exit.country;
    } catch {
      afterIp = undefined;
    }

    const changed = afterIp !== undefined && afterIp !== beforeIp;
    const noteKey = changed
      ? fellBackToAnotherCity
        ? 'rotated-to-another-city'
        : undefined
      : afterIp === undefined
        ? 'probe-failed'
        : 'exit-ip-unchanged';

    const finalKey = nextTarget.key;
    deps.state.setState((st) => {
      const { [key]: _old, ...restServers } = st.portServers;
      return {
        ...st,
        portServers: { ...restServers, [finalKey]: nextServer! },
        ports: st.ports.map((p) => {
          if (p.key !== key) return p;
          const identity =
            finalKey !== p.key
              ? { key: finalKey, country: nextTarget!.country, city: nextTarget!.city, label: nextTarget!.label }
              : {};
          if (!changed) return { ...p, ...identity };
          return { ...p, ...identity, state: { kind: 'online', since: Date.now(), exitIp: afterIp!, country: afterCountry! } };
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
    const creds: ExportCreds = { host: '127.0.0.1', user: s.settings.proxyUser, pass: s.settings.proxyPass };
    const ports = keys.map((k) => s.ports.find((p) => p.key === k)).filter((p): p is PortRow => Boolean(p));
    return exportLines(format, ports.map((p) => p.proxyPort), creds);
  }

  async function testPort(key: string, _speed: boolean): Promise<{ ok: boolean; exitIp?: string; latencyMs?: number; mbps?: number }> {
    const port = findPort(key);
    if (!port) return { ok: false };
    const startedAt = Date.now();
    try {
      const exit = await deps.exitIp.probe(port.proxyPort);
      return { ok: true, exitIp: exit.ip, latencyMs: Date.now() - startedAt };
      // Speed test (speed.cloudflare.com, §4.2) needs its own probe port, not yet
      // injected here — see the report's "Known gaps" for how to extend this.
    } catch {
      return { ok: false };
    }
  }

  return { startPort, stopPort, removePort, rotatePort, setAutoRotate, exportPorts, testPort, ensurePort };
}
