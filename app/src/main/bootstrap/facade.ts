import { isIP } from 'node:net';
import path from 'node:path';
import {
  splitPortKey,
  type Account,
  type AccountSecret,
  type AppStatus,
  type CheckResult,
  type PortRow,
  type Provider,
  type ProviderId,
  type RotateResult,
  type Settings,
  type Target,
} from '../../shared/contracts';
import type { AccountPool } from '../accounts/pool';
import type { HostVpnDetector } from '../controller/host-vpn';
import type { PortManager } from '../controller/port-manager';
import type { PortAllocator } from '../controller/ports';
import type { StartQueue } from '../controller/start-queue';
import { applySettingsPatch } from '../controller/settings';
import type { ControllerFacade } from '../ipc/index';
import type { SecretStore } from '../store/secrets';
import type { StateStore } from '../store/state';
import type { UpdateStatus } from '../../shared/contracts';
import { collectDiagnostics, type DiagnosticsEnv } from './diagnostics';
import type { HmaLocalSource } from './hma-local';

export const PROVIDER_IDS: ProviderId[] = ['hma', 'zoogvpn', 'surfshark', 'file'];

/** The slice of the `UpdaterService` the facade drives from IPC (spec §9). */
export interface FacadeUpdater {
  getStatus(): UpdateStatus;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadAndInstall(): Promise<{ success: boolean; error?: string }>;
}

export interface FacadeDeps {
  state: StateStore;
  secrets: SecretStore;
  providers: { get(id: ProviderId): Provider | undefined };
  portManager: PortManager;
  pool: AccountPool;
  queue: StartQueue;
  allocator: PortAllocator;
  engineLogs(key: string): string[];
  hostVpn: HostVpnDetector;
  hma: HmaLocalSource;
  platform: NodeJS.Platform;
  /** Throughput through a port's own proxy (spec §4.2 speed test). */
  speedTest(proxyPort: number, auth?: { username: string; password: string }): Promise<number>;
  /** Called after an accepted settings change was persisted (restart ports/webhook, …). */
  onSettingsChanged?(prev: Settings, next: Settings): void | Promise<void>;
  appStatus(): AppStatus;
  /** Auto-updater (spec §9). The renderer's "Check for updates" / "Restart & install"
   * buttons come through here. */
  updater: FacadeUpdater;
  /** Versions/OS for "Copy diagnostics"; the facade adds the redacted counts. */
  diagnosticsEnv(): DiagnosticsEnv;
  log?: (msg: string, err?: unknown) => void;
}

/** port-manager's rotate noteKeys → the i18n keys the renderer resolves (`MainScreen`). */
export function rotateNoteKey(noteKey: string | undefined): string | undefined {
  if (noteKey === undefined) return undefined;
  if (noteKey === 'rotated-to-another-city') return 'main.rotateResult.sameCityNote';
  if (noteKey === 'no-server') return 'main.rotateResult.unchangedNote';
  // An explicit Change-IP pick that is held, unusable, not in the pool, or already current.
  if (noteKey === 'server-unavailable' || noteKey === 'already-on-server') return 'main.rotateResult.serverTaken';
  return `rotate.${noteKey}`;
}

/** Same heuristic as the UI's file card: first 2-letter token of the file name. */
export function guessCountry(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const token = stem.split(/[^A-Za-z]+/).find((t) => t.length === 2);
  return token ? token.toUpperCase() : '';
}

/**
 * The `ProxyFarmApi` implementation behind IPC (spec §3): glue between the renderer's
 * contract and the controller modules. It owns account creation (secrets saved as
 * `JSON.stringify(AccountSecret)` under `account:<id>` — port-manager's convention),
 * target→account resolution for brand-new ports, and the staggered start queue.
 */
export function createControllerFacade(deps: FacadeDeps): ControllerFacade {
  const log = deps.log ?? ((msg: string, err?: unknown) => console.error(`[facade] ${msg}`, err ?? ''));

  const accounts = () => deps.state.getState().accounts;
  const findPort = (key: string) => deps.state.getState().ports.find((p) => p.key === key);

  function patchPort(key: string, patch: Partial<PortRow>): void {
    deps.state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
  }

  function enqueueStart(key: string): void {
    patchPort(key, { enabled: true, state: { kind: 'queued' } });
    // Only user actions come through here (Start, Add ports): they reset the back-off.
    deps.queue.enqueue(key, () => deps.portManager.startPort(key, { user: true }));
  }

  function nextAccountId(providerId: ProviderId): string {
    const taken = new Set(accounts().map((a) => a.id));
    let n = 1;
    while (taken.has(`${providerId}-${n}`)) n += 1;
    return `${providerId}-${n}`;
  }

  function saveAccountSecret(secretRef: string, secret: AccountSecret): void {
    deps.secrets.saveSecret(secretRef, JSON.stringify(secret));
  }

  /** Overwrites an existing account's secret; if it really changed, server marks earned
   * under the old credentials are dropped (a 7-day refusal must not outlive them). */
  function replaceAccountSecret(account: Account, secret: AccountSecret): void {
    const next = JSON.stringify(secret);
    if (deps.secrets.loadSecret(account.secretRef) === next) return;
    deps.secrets.saveSecret(account.secretRef, next);
    deps.portManager.credentialsChanged(account.id);
  }

  function createAccount(providerId: ProviderId, label: string, secret: AccountSecret, meta: Record<string, string>): Account {
    const id = nextAccountId(providerId);
    const account: Account = { id, providerId, label, meta, secretRef: `account:${id}` };
    saveAccountSecret(account.secretRef, secret);
    deps.state.setState((s) => ({ ...s, accounts: [...s.accounts, account] }));
    return account;
  }

  async function detectHma(): Promise<{ found: boolean; hintKey?: string }> {
    const r = await deps.hma.read();
    if (r.status === 'found') return { found: true };
    if (r.status === 'helper-missing') return { found: false, hintKey: 'hma.helperMissing' };
    if (r.status === 'invalid') return { found: false, hintKey: 'hma.notSignedIn' };
    return { found: false };
  }

  async function targetsFor(providerId: ProviderId): Promise<Target[]> {
    const provider = deps.providers.get(providerId);
    if (!provider) return [];
    const seen = new Map<string, Target>();
    for (const account of accounts().filter((a) => a.providerId === providerId)) {
      try {
        for (const t of await provider.targets(account)) if (!seen.has(t.key)) seen.set(t.key, t);
      } catch (err) {
        log(`targets() failed for ${account.id}`, err);
      }
    }
    return [...seen.values()];
  }

  function providerOf(locationKey: string): ProviderId | undefined {
    const providerId = locationKey.split(':')[0] as ProviderId;
    return PROVIDER_IDS.includes(providerId) ? providerId : undefined;
  }

  async function findTarget(locationKey: string): Promise<Target | undefined> {
    const providerId = providerOf(locationKey);
    return providerId ? (await targetsFor(providerId)).find((t) => t.key === locationKey) : undefined;
  }

  /** Accounts to try for a new port, best first: the pool's least-loaded pick, then the
   * provider's other accounts (a server refused for one account may still be usable by
   * another — spec §6.8). A file target belongs to exactly one imported file. */
  function accountsForNewPort(providerId: ProviderId, locationKey: string): Account[] {
    if (providerId === 'file') return accounts().filter((a) => `file:${a.id}` === locationKey);
    const first = deps.pool.pickAccount(providerId);
    const rest = accounts().filter((a) => a.providerId === providerId && a.id !== first?.id);
    return first ? [first, ...rest] : rest;
  }

  /** spec §6.8 "Add k ports": each on a different free usable server, spread across the
   * provider's accounts, capped by the provider's port limit. */
  async function addPorts(locationKey: string, count: number): Promise<{ added: PortRow[]; noteKey?: string }> {
    const target = await findTarget(locationKey);
    if (!target) {
      log(`addPorts: unknown location ${locationKey}`);
      return { added: [], noteKey: 'no-free-server' };
    }
    // One port per server — except that a round-robin pool hostname may stand for many
    // servers, so there the port manager's own pick decides when the pool is used up.
    const requested = Math.max(0, Math.floor(Number(count) || 0));
    const poolHostname = target.poolHostnames === true && target.servers.some((s) => !isIP(s));
    const wanted = poolHostname ? requested : Math.min(requested, target.servers.length);
    const added: PortRow[] = [];
    let noteKey: string | undefined;
    while (added.length < wanted) {
      if (deps.pool.atLimit(target.providerId)) {
        noteKey = 'limit-reached';
        break;
      }
      // The limit is checked again inside the port manager's claim lock: a concurrent
      // addPorts may have taken the last slot since the check above.
      const atLimit = () => deps.pool.atLimit(target.providerId);
      let row: PortRow | undefined;
      for (const account of accountsForNewPort(target.providerId, locationKey)) {
        row = await deps.portManager.addPort(target, account.id, { atLimit });
        if (row) break;
      }
      if (!row) {
        noteKey = atLimit() ? 'limit-reached' : 'no-free-server';
        break;
      }
      added.push(row);
      enqueueStart(row.key);
    }
    if (added.length < requested && !noteKey) noteKey = 'no-free-server';
    return { added: added.map((r) => findPort(r.key) ?? r), ...(noteKey ? { noteKey } : {}) };
  }

  async function startOne(key: string): Promise<void> {
    const row = findPort(key);
    if (!row) {
      // A bare location key (pre-rev-3 callers) means "add one port there".
      if (!splitPortKey(key)) await addPorts(key, 1);
      else log(`startPorts: unknown port ${key}`);
      return;
    }
    if (!row.enabled && deps.pool.atLimit(row.providerId)) return log(`startPorts: ${row.providerId} at its port limit`);
    if (row.state.kind === 'failed' && row.state.reason === 'port-in-use') {
      // "Move to another port" (spec §6.2): the persisted proxy port is held by
      // something else, so this restart allocates a fresh one.
      const { settings, ports } = deps.state.getState();
      const taken = new Set(ports.map((p) => p.proxyPort));
      const proxyPort = await deps.allocator.allocate({ base: settings.basePort, taken });
      patchPort(key, { proxyPort });
    }
    enqueueStart(row.key);
  }

  async function connectHma(): Promise<CheckResult & { account?: Account }> {
    if (deps.platform !== 'darwin') return { ok: false, reasonKey: 'hma.windowsLater' };
    const r = await deps.hma.read();
    if (r.status === 'missing') return { ok: false, reasonKey: 'hma.notFound' };
    if (r.status !== 'found') return { ok: false, reasonKey: 'hma.notSignedIn' };
    const provider = deps.providers.get('hma');
    if (!provider) return { ok: false, reasonKey: 'hma.notFound' };
    const check = provider.check({ udid: r.creds.udid, password: r.creds.password });
    if (!check.ok || !check.secret) return { ok: false, reasonKey: check.reasonKey, label: check.label };
    const meta = { ...(check.meta ?? {}), source: 'local' };
    const existing = accounts().find((a) => a.providerId === 'hma' && a.meta.source === 'local');
    if (existing) {
      replaceAccountSecret(existing, check.secret);
      const updated: Account = { ...existing, label: check.label ?? existing.label, meta };
      deps.state.setState((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === existing.id ? updated : a)) }));
      return { ok: true, label: updated.label, account: updated };
    }
    const account = createAccount('hma', check.label ?? 'HMA', check.secret, meta);
    return { ok: true, label: account.label, account };
  }

  async function importConfigFile(name: string, content: string, country?: string): Promise<CheckResult & { account?: Account }> {
    const provider = deps.providers.get('file');
    if (!provider) return { ok: false, reasonKey: 'file.check.parseError' };
    const check = provider.check({ name, content });
    if (!check.ok || !check.secret) return { ok: false, reasonKey: check.reasonKey, label: check.label };
    const cc = (country?.trim() || guessCountry(name) || '??').toUpperCase().slice(0, 2);
    const city = path.basename(name).replace(/\.[^.]+$/, '');
    const account = createAccount('file', check.label ?? name, check.secret, { ...(check.meta ?? {}), country: cc, city, fileName: name });
    return { ok: true, label: account.label, account };
  }

  return {
    async listProviders() {
      const { limits } = deps.state.getState();
      const hmaDetected = await detectHma();
      return PROVIDER_IDS.map((id) => ({
        id,
        accounts: accounts().filter((a) => a.providerId === id),
        detected: id === 'hma' ? hmaDetected : undefined,
        limit: limits[id] ?? 0,
      }));
    },

    async addAccount(providerId, input) {
      if (providerId === 'hma' && !input.udid) return connectHma();
      if (providerId === 'file') return importConfigFile(input.name ?? '', input.content ?? '', input.country);
      const provider = deps.providers.get(providerId);
      if (!provider) return { ok: false, reasonKey: 'checkResult.reason.invalid-format' };
      // The ZoogVPN card labels its login field "email"; the provider calls it username.
      const normalized = providerId === 'zoogvpn' && !input.username ? { ...input, username: input.email ?? '' } : input;
      const check = provider.check(normalized);
      if (!check.ok || !check.secret) return { ok: false, reasonKey: check.reasonKey, label: check.label };
      const duplicate = accounts().find((a) => a.providerId === providerId && a.label === (check.label ?? ''));
      if (duplicate) {
        replaceAccountSecret(duplicate, check.secret);
        // Re-adding the same key with a corrected interface address (Surfshark) is a
        // credentials change too: what failed under the old address proves nothing.
        const meta = { ...duplicate.meta, ...(check.meta ?? {}) };
        if (JSON.stringify(meta) === JSON.stringify(duplicate.meta)) return { ok: true, label: duplicate.label, account: duplicate };
        const updated: Account = { ...duplicate, meta };
        deps.state.setState((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === duplicate.id ? updated : a)) }));
        deps.portManager.credentialsChanged(duplicate.id);
        return { ok: true, label: updated.label, account: updated };
      }
      const account = createAccount(providerId, check.label ?? providerId, check.secret, check.meta ?? {});
      return { ok: true, label: account.label, account };
    },

    async removeAccount(accountId) {
      const account = accounts().find((a) => a.id === accountId);
      if (!account) return;
      for (const p of deps.state.getState().ports.filter((r) => r.accountId === accountId)) {
        deps.queue.cancel(p.key);
        await deps.portManager.removePort(p.key);
      }
      deps.secrets.deleteSecret(account.secretRef);
      deps.state.setState((s) => ({ ...s, accounts: s.accounts.filter((a) => a.id !== accountId) }));
    },

    connectHma,

    async enableHmaSupport() {
      // spec §7: the Windows helper installer is a later track.
      return { ok: false, reasonKey: 'hma.windowsLater' };
    },

    importConfigFile,

    async listTargets(providerId) {
      const ids = providerId ? [providerId] : PROVIDER_IDS;
      const out: Target[] = [];
      for (const id of ids) for (const t of await targetsFor(id)) out.push({ ...t, freeServers: deps.portManager.freeServerCount(t) });
      return out;
    },

    async listServers(locationKey, portKey) {
      const target = await findTarget(locationKey);
      return target ? deps.portManager.listServers(target, portKey) : [];
    },

    async listPorts() {
      return deps.state.getState().ports;
    },

    addPorts,

    async startPorts(keys) {
      for (const key of keys) {
        try {
          await startOne(key);
        } catch (err) {
          log(`startPorts: ${key} failed`, err);
        }
      }
    },

    async stopPorts(keys) {
      for (const key of keys) {
        deps.queue.cancel(key);
        await deps.portManager.stopPort(key);
      }
    },

    async removePorts(keys) {
      for (const key of keys) {
        deps.queue.cancel(key);
        await deps.portManager.removePort(key);
      }
    },

    async rotatePort(key, toServer): Promise<RotateResult> {
      const result = await deps.portManager.rotatePort(key, toServer, { user: true });
      return { ...result, noteKey: rotateNoteKey(result.noteKey) };
    },

    setAutoRotate: (key, minutes) => deps.portManager.setAutoRotate(key, minutes),

    async setLimit(providerId, limit) {
      const value = Math.max(0, Math.floor(Number(limit) || 0));
      deps.state.setState((s) => ({ ...s, limits: { ...s.limits, [providerId]: value } }));
    },

    async testPort(key, speed) {
      const result = await deps.portManager.testPort(key, false);
      if (!speed || !result.ok) return result;
      const port = findPort(key);
      const { settings } = deps.state.getState();
      const auth = settings.proxyUser && settings.proxyPass ? { username: settings.proxyUser, password: settings.proxyPass } : undefined;
      try {
        return { ...result, mbps: await deps.speedTest(port!.proxyPort, auth) };
      } catch (err) {
        log(`speed test failed for ${key}`, err);
        return result;
      }
    },

    async getLogs(key) {
      return deps.engineLogs(key);
    },

    exportPorts: (keys, format) => deps.portManager.exportPorts(keys, format),

    async getSettings() {
      return deps.state.getState().settings;
    },

    async setSettings(patch) {
      const prev = deps.state.getState().settings;
      const result = applySettingsPatch(prev, patch);
      if (!result.ok) throw new Error(result.reasonKey);
      deps.state.setState((s) => ({ ...s, settings: result.settings }));
      await deps.onSettingsChanged?.(prev, result.settings);
      return result.settings;
    },

    async getHostVpnActive() {
      return deps.hostVpn.isHostVpnActive().catch(() => false);
    },

    async getAppStatus() {
      return deps.appStatus();
    },

    async getUpdateStatus() {
      return deps.updater.getStatus();
    },

    checkForUpdate: () => deps.updater.checkForUpdates(),

    downloadAndInstallUpdate: () => deps.updater.downloadAndInstall(),

    async getDiagnostics() {
      const { accounts: accountList, ports } = deps.state.getState();
      return collectDiagnostics({ accounts: accountList, ports }, deps.diagnosticsEnv(), PROVIDER_IDS);
    },
  };
}
