import path from 'node:path';
import type {
  Account,
  AccountSecret,
  AppStatus,
  CheckResult,
  PortRow,
  Provider,
  ProviderId,
  RotateResult,
  Settings,
  Target,
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
import type { HmaLocalSource } from './hma-local';

export const PROVIDER_IDS: ProviderId[] = ['hma', 'zoogvpn', 'surfshark', 'file'];

/** The slice of the `UpdaterService` the facade drives from IPC (spec §9). */
export interface FacadeUpdater {
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
  log?: (msg: string, err?: unknown) => void;
}

/** port-manager's rotate noteKeys → the i18n keys the renderer resolves (`MainScreen`). */
export function rotateNoteKey(noteKey: string | undefined): string | undefined {
  if (noteKey === undefined) return undefined;
  if (noteKey === 'rotated-to-another-city') return 'main.rotateResult.sameCityNote';
  if (noteKey === 'no-server') return 'main.rotateResult.unchangedNote';
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
    deps.queue.enqueue(key, () => deps.portManager.startPort(key));
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

  function accountForNewPort(providerId: ProviderId, key: string): Account | undefined {
    // A file target belongs to exactly one imported file (account) — never pool it.
    if (providerId === 'file') {
      if (deps.pool.atLimit('file')) return undefined;
      return accounts().find((a) => `file:${a.id}` === key);
    }
    return deps.pool.pickAccount(providerId, { key });
  }

  async function startOne(key: string, targetCache: Map<ProviderId, Target[]>): Promise<void> {
    let row = findPort(key);
    if (!row) {
      const providerId = key.split(':')[0] as ProviderId;
      if (!PROVIDER_IDS.includes(providerId)) return;
      if (!targetCache.has(providerId)) targetCache.set(providerId, await targetsFor(providerId));
      const target = targetCache.get(providerId)!.find((t) => t.key === key);
      if (!target) return log(`startPorts: unknown target ${key}`);
      const account = accountForNewPort(providerId, key);
      if (!account) return log(`startPorts: no account with room for ${key}`);
      row = await deps.portManager.ensurePort(target, account.id);
    } else {
      if (!row.enabled && deps.pool.atLimit(row.providerId)) return log(`startPorts: ${row.providerId} at its port limit`);
      if (row.state.kind === 'failed' && row.state.reason === 'port-in-use') {
        // "Move to another port" (spec §6.2): the persisted proxy port is held by
        // something else, so this restart allocates a fresh one.
        const { settings, ports } = deps.state.getState();
        const taken = new Set(ports.map((p) => p.proxyPort));
        const proxyPort = await deps.allocator.allocate({ base: settings.basePort, taken });
        patchPort(key, { proxyPort });
      }
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
      saveAccountSecret(existing.secretRef, check.secret);
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
        saveAccountSecret(duplicate.secretRef, check.secret);
        return { ok: true, label: duplicate.label, account: duplicate };
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
      for (const id of ids) out.push(...(await targetsFor(id)));
      return out;
    },

    async listPorts() {
      return deps.state.getState().ports;
    },

    async startPorts(keys) {
      const cache = new Map<ProviderId, Target[]>();
      for (const key of keys) {
        try {
          await startOne(key, cache);
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

    async rotatePort(key): Promise<RotateResult> {
      const result = await deps.portManager.rotatePort(key);
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

    checkForUpdate: () => deps.updater.checkForUpdates(),

    downloadAndInstallUpdate: () => deps.updater.downloadAndInstall(),
  };
}
