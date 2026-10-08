/**
 * Renderer entry point to the controller. The UI never imports Electron or
 * touches `window.proxyFarm` directly outside this file — it calls
 * `getProxyFarmApi()`. When `window.proxyFarm` is missing (dev server,
 * vitest/jsdom, a future Storybook), a realistic in-memory FAKE stands in so
 * the whole UI stays runnable and testable standalone, per the contracts in
 * ../shared/contracts.
 */
import type {
  Account,
  AccountSecret,
  CheckResult,
  ExportFormat,
  PortRow,
  ProviderId,
  ProxyFarmApi,
  RotateResult,
  ServerHealth,
  Settings,
  Target,
  UpdateStatus,
} from '../shared/contracts';
import { makePortKey, splitPortKey } from '../shared/contracts';

export function getProxyFarmApi(): ProxyFarmApi {
  const injected = typeof window !== 'undefined' ? window.proxyFarm : undefined;
  if (injected) {
    return injected;
  }
  return createFakeProxyFarmApi();
}

// ───────────────────────── fake implementation ─────────────────────────

type Listener<T> = (value: T) => void;

interface FakeAccountRecord {
  account: Account;
  secret: AccountSecret;
}

const COUNTRY_LABEL: Record<string, string> = {
  JP: 'Japan',
  US: 'United States',
  NL: 'Netherlands',
  VN: 'Vietnam',
  SG: 'Singapore',
  DE: 'Germany',
};

function makeTarget(key: string, providerId: ProviderId, country: string, city: string, servers: string[]): Target {
  return { key, providerId, country, city, label: `${city}, ${COUNTRY_LABEL[country] ?? country}`, servers };
}

/**
 * Sample locations, each with a pool of servers (spec §6.8): one server = one
 * fixed exit IP. ZoogVPN keys are `zoogvpn:<CC>` or `zoogvpn:<CC>-<CITY>` and its
 * pools are hostnames (resolved via SAMPLE_RESOLVE); the others are IP literals. Tokyo is deliberately the richest pool, with one
 * refused and one dead server, so the Change-IP menu shows every health state.
 */
const SAMPLE_TARGETS: Target[] = [
  makeTarget('hma:JP-TOKYO', 'hma', 'JP', 'Tokyo', [
    '203.0.113.10',
    '203.0.113.11',
    '203.0.113.12',
    '203.0.113.13',
    '203.0.113.14',
    '203.0.113.15',
  ]),
  makeTarget('hma:US-NYC', 'hma', 'US', 'New York', ['203.0.113.20']),
  makeTarget('hma:SG-SIN', 'hma', 'SG', 'Singapore', ['203.0.113.30', '203.0.113.31']),
  makeTarget('zoogvpn:NL', 'zoogvpn', 'NL', 'Amsterdam', ['nl1.webunlim.com']),
  makeTarget('zoogvpn:VN-HAN', 'zoogvpn', 'VN', 'Hanoi', ['vn1.webunlim.com', 'vn2.webunlim.com']),
  makeTarget('surfshark:DE-FRA', 'surfshark', 'DE', 'Frankfurt', ['192.0.2.10', '192.0.2.11', '192.0.2.12']),
  // Same-country sibling of hma:US-NYC: exercises Change IP's "moved to another
  // city" path (spec §6.5 step 2) once New York's only server is taken.
  makeTarget('hma:US-LA', 'hma', 'US', 'Los Angeles', ['203.0.113.21']),
];

const SAMPLE_RESOLVE: Record<string, string> = {
  'nl1.webunlim.com': '198.51.100.10',
  'vn1.webunlim.com': '198.51.100.20',
  'vn2.webunlim.com': '198.51.100.21',
};

function resolveServer(server: string): string {
  return SAMPLE_RESOLVE[server] ?? server;
}

function findTarget(locationKey: string): Target | undefined {
  return SAMPLE_TARGETS.find((t) => t.key === locationKey);
}

function samplePortRow(
  target: Target,
  n: number,
  server: string | undefined,
  accountId: string,
  proxyPort: number,
  state: PortRow['state'],
): PortRow {
  return {
    key: makePortKey(target.key, n),
    locationKey: target.key,
    server,
    serverIp: server ? resolveServer(server) : undefined,
    providerId: target.providerId,
    accountId,
    label: target.label,
    country: target.country,
    city: target.city,
    proxyPort,
    enabled: state.kind !== 'stopped',
    state,
    autoRotateMin: 0,
  };
}

export interface FakeProxyFarmApi extends ProxyFarmApi {
  /** Test/dev-only hook: flip the simulated "another VPN is active" signal. */
  __setHostVpnActive(active: boolean): void;
}

export function createFakeProxyFarmApi(): FakeProxyFarmApi {
  const now = Date.now();

  const accounts: FakeAccountRecord[] = [
    {
      account: { id: 'hma-1', providerId: 'hma', label: 'HMA (this device)', meta: { udid: 'device-demo' }, secretRef: 'hma-1' },
      secret: { kind: 'userpass', username: 'device-demo', password: 'demo' },
    },
    {
      account: {
        id: 'zoogvpn-1',
        providerId: 'zoogvpn',
        label: 'demo@example.com',
        meta: { email: 'demo@example.com' },
        secretRef: 'zoogvpn-1',
      },
      secret: { kind: 'userpass', username: 'demo@example.com', password: 'demo' },
    },
  ];

  let settings: Settings = {
    proxyUser: 'proxyfarm',
    proxyPass: 'demo-pass-1234',
    basePort: 29001,
    lanSharing: false,
    keepAwake: true,
    launchAtLogin: false,
    giveUpAfter: 0,
    webhook: { enabled: false, port: 29999, bearer: '' },
    language: 'vi',
    autoCheckUpdates: true,
    acknowledgedDisclaimer: 0,
  };

  let hostVpnActive = false;
  const limits = new Map<ProviderId, number>();
  const logCounters = new Map<string, number>();

  const surfsharkAccountId = 'surfshark-demo';
  const ports = new Map<string, PortRow>(
    [
      samplePortRow(SAMPLE_TARGETS[0], 1, '203.0.113.10', 'hma-1', 29001, {
        kind: 'online',
        since: now - 5 * 60_000,
        exitIp: '203.0.113.10',
        country: 'JP',
        latencyMs: 42,
      }),
      samplePortRow(SAMPLE_TARGETS[1], 1, '203.0.113.20', 'hma-1', 29002, {
        kind: 'retrying',
        untilMs: now + 30_000,
        attempt: 2,
        reasonKey: 'portState.failed.no-server.guidance',
      }),
      samplePortRow(SAMPLE_TARGETS[3], 1, 'nl1.webunlim.com', 'zoogvpn-1', 29003, {
        kind: 'failed',
        reason: 'auth',
        untilMs: now + 30 * 60_000,
        attempt: 5,
      }),
      samplePortRow(SAMPLE_TARGETS[5], 1, '192.0.2.10', surfsharkAccountId, 29004, { kind: 'stopped' }),
      samplePortRow(SAMPLE_TARGETS[0], 2, '203.0.113.11', 'hma-1', 29005, {
        kind: 'online',
        since: now - 2 * 60_000,
        exitIp: '203.0.113.11',
        country: 'JP',
        latencyMs: 51,
      }),
    ].map((row) => [row.key, row]),
  );

  // Server health per pool token (spec §6.8). The fake has one account per
  // provider, so health is per server rather than per (account, server).
  const health = new Map<string, { health: ServerHealth; lastOk?: number }>();
  for (const target of SAMPLE_TARGETS) {
    for (const server of target.servers) health.set(server, { health: 'unknown' });
  }
  for (const server of ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.20', 'nl1.webunlim.com']) {
    health.set(server, { health: 'ok', lastOk: now - 60_000 });
  }
  health.set('203.0.113.13', { health: 'refused' });
  health.set('203.0.113.14', { health: 'dead', lastOk: now - 3 * 3_600_000 });

  const portsListeners = new Set<Listener<PortRow[]>>();
  const hostVpnListeners = new Set<Listener<boolean>>();
  const updateStatusListeners = new Set<Listener<UpdateStatus>>();
  const appVersion = typeof __PROXYFARM_APP_VERSION__ !== 'undefined' ? __PROXYFARM_APP_VERSION__ : 'dev';
  let updateStatus: UpdateStatus = { phase: 'idle', currentVersion: appVersion };

  function emitUpdateStatus(next: UpdateStatus): void {
    updateStatus = next;
    for (const listener of updateStatusListeners) listener(next);
  }

  /** Copies, like rows that crossed IPC: the UI must never share the fake's live objects. */
  function snapshot(): PortRow[] {
    return Array.from(ports.values(), (row) => ({ ...row }));
  }

  function emitPorts(): void {
    const rows = snapshot();
    for (const listener of portsListeners) listener(rows);
  }

  function emitHostVpn(): void {
    for (const listener of hostVpnListeners) listener(hostVpnActive);
  }

  function nextPort(): number {
    const used = new Set(Array.from(ports.values()).map((p) => p.proxyPort));
    let candidate = settings.basePort;
    while (used.has(candidate)) candidate += 1;
    return candidate;
  }

  function usable(server: string): boolean {
    const h = health.get(server)?.health ?? 'unknown';
    return h !== 'refused' && h !== 'dead';
  }

  /** Port key holding `server`, comparing resolved IPs (spec §6.8 allocation invariant). */
  function holderOf(server: string): string | undefined {
    const ip = resolveServer(server);
    for (const row of ports.values()) {
      if (row.server && resolveServer(row.server) === ip) return row.key;
    }
    return undefined;
  }

  /** Usable, unheld servers of a location, best first (most recent OK, then pool order). */
  function freeServersOf(target: Target): string[] {
    return target.servers
      .filter((s) => usable(s) && !holderOf(s))
      .map((server, index) => ({ server, index, lastOk: health.get(server)?.lastOk ?? 0 }))
      .sort((a, b) => b.lastOk - a.lastOk || a.index - b.index)
      .map((entry) => entry.server);
  }

  /** Smallest free port number n ≥ 1 in a location (spec §6.8). */
  function nextN(locationKey: string): number {
    const used = new Set(
      Array.from(ports.values())
        .filter((p) => p.locationKey === locationKey)
        .map((p) => splitPortKey(p.key)?.n ?? 0),
    );
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  }

  /** Enabled ports this provider may still add; Infinity when unlimited (limit 0). */
  function remainingFor(providerId: ProviderId): number {
    const limit = limits.get(providerId) ?? 0;
    if (!limit) return Infinity;
    const enabled = Array.from(ports.values()).filter((p) => p.providerId === providerId && p.enabled).length;
    return Math.max(0, limit - enabled);
  }

  function accountFor(providerId: ProviderId): string {
    if (providerId === 'surfshark') return surfsharkAccountId;
    return accounts.find((a) => a.account.providerId === providerId)?.account.id ?? 'unknown';
  }

  function pin(row: PortRow, server: string): void {
    row.server = server;
    row.serverIp = resolveServer(server);
  }

  async function simulateConnect(key: string): Promise<void> {
    const row = ports.get(key);
    if (!row) return;
    row.state = { kind: 'connecting', since: Date.now() };
    row.enabled = true;
    emitPorts();
    row.state = { kind: 'verifying', since: Date.now() };
    emitPorts();
    if (row.server) health.set(row.server, { health: 'ok', lastOk: Date.now() });
    row.state = {
      kind: 'online',
      since: Date.now(),
      exitIp: row.serverIp ?? '203.0.113.99',
      country: row.country,
      latencyMs: 55,
    };
    emitPorts();
  }

  const api: FakeProxyFarmApi = {
    async listProviders() {
      return (['hma', 'zoogvpn', 'surfshark', 'file'] as ProviderId[]).map((id) => ({
        id,
        accounts: accounts.filter((a) => a.account.providerId === id).map((a) => a.account),
        detected: id === 'hma' ? { found: true } : undefined,
        limit: limits.get(id) ?? 0,
      }));
    },

    async addAccount(providerId, input) {
      if (providerId === 'zoogvpn') {
        if (!input.email || !input.password) {
          return { ok: false, reasonKey: 'checkResult.reason.invalid-format' };
        }
        const account: Account = {
          id: `zoogvpn-${accounts.length + 1}`,
          providerId,
          label: input.email,
          meta: { email: input.email },
          secretRef: `zoogvpn-${accounts.length + 1}`,
        };
        accounts.push({ account, secret: { kind: 'userpass', username: input.email, password: input.password } });
        return { ok: true, account, label: input.email };
      }
      if (providerId === 'surfshark') {
        if (!input.privateKey || input.privateKey.length < 10) {
          return { ok: false, reasonKey: 'checkResult.reason.invalid-format' };
        }
        const account: Account = {
          id: `surfshark-${accounts.length + 1}`,
          providerId,
          label: `key …${input.privateKey.slice(-4)}`,
          meta: {},
          secretRef: `surfshark-${accounts.length + 1}`,
        };
        accounts.push({ account, secret: { kind: 'wgkey', privateKey: input.privateKey } });
        return { ok: true, account, label: account.label };
      }
      return { ok: false, reasonKey: 'checkResult.reason.invalid-format' };
    },

    async removeAccount(accountId) {
      const idx = accounts.findIndex((a) => a.account.id === accountId);
      if (idx >= 0) accounts.splice(idx, 1);
    },

    async connectHma() {
      const account: Account = accounts.find((a) => a.account.providerId === 'hma')?.account ?? {
        id: 'hma-1',
        providerId: 'hma',
        label: 'HMA (this device)',
        meta: { udid: 'device-demo' },
        secretRef: 'hma-1',
      };
      return { ok: true, account, label: account.label };
    },

    async enableHmaSupport() {
      // Simulates spec §7: install the elevated Windows helper (one UAC).
      // The fake has no real installer to run, so it just reports success.
      return { ok: true, label: 'HMA helper installed' };
    },

    async importConfigFile(name, content, country) {
      if (!content.includes('PrivateKey') && !content.includes('remote ')) {
        return { ok: false, reasonKey: 'checkResult.reason.invalid-format' };
      }
      const account: Account = {
        id: `file-${accounts.length + 1}`,
        providerId: 'file',
        label: name,
        meta: country ? { name, country } : { name },
        secretRef: `file-${accounts.length + 1}`,
      };
      accounts.push({ account, secret: { kind: 'file', content } });
      return { ok: true, account, label: name };
    },

    async listTargets(providerId) {
      return SAMPLE_TARGETS.filter((t) => !providerId || t.providerId === providerId).map((t) => ({
        ...t,
        servers: [...t.servers],
        freeServers: freeServersOf(t).length,
      }));
    },

    // The fake keeps one health map for every account, so `portKey` changes nothing here.
    async listServers(locationKey, _portKey) {
      const target = findTarget(locationKey);
      return (target?.servers ?? []).map((server) => {
        const h = health.get(server) ?? { health: 'unknown' as const };
        return { server, ip: resolveServer(server), health: h.health, lastOk: h.lastOk, heldBy: holderOf(server) };
      });
    },

    async listPorts() {
      return snapshot();
    },

    async addPorts(locationKey, count) {
      const target = findTarget(locationKey);
      if (!target || count < 1) return { added: [] };
      const free = freeServersOf(target);
      const remaining = remainingFor(target.providerId);
      const n = Math.min(count, free.length, remaining);
      const added: PortRow[] = [];
      for (let i = 0; i < n; i++) {
        const row = samplePortRow(target, nextN(locationKey), free[i], accountFor(target.providerId), nextPort(), {
          kind: 'queued',
        });
        ports.set(row.key, row);
        added.push(row);
      }
      emitPorts();
      for (const row of added) await simulateConnect(row.key);
      const result = added.map((row) => ({ ...(ports.get(row.key) ?? row) }));
      if (n === count) return { added: result };
      // The tighter of the two caps explains the shortfall.
      return {
        added: result,
        noteKey: remaining < Math.min(count, free.length) ? 'limit-reached' : 'no-free-server',
      };
    },

    async startPorts(portKeys) {
      for (const key of portKeys) {
        // A bare location key means "add one port to that location" (contracts).
        if (!splitPortKey(key) && findTarget(key)) {
          await api.addPorts(key, 1);
          continue;
        }
        const row = ports.get(key);
        if (!row) continue;
        // Re-select instead of reusing a stale choice (spec §6.8 failover).
        if (!row.server || !usable(row.server) || (holderOf(row.server) ?? row.key) !== row.key) {
          const target = findTarget(row.locationKey);
          const next = target ? freeServersOf(target)[0] : undefined;
          if (next) pin(row, next);
        }
        row.state = { kind: 'queued' };
        emitPorts();
        await simulateConnect(key);
      }
    },

    async stopPorts(portKeys) {
      for (const key of portKeys) {
        const row = ports.get(key);
        if (row) {
          row.state = { kind: 'stopped' };
          row.enabled = false;
        }
      }
      emitPorts();
    },

    async removePorts(portKeys) {
      for (const key of portKeys) ports.delete(key);
      emitPorts();
    },

    async rotatePort(portKey, toServer): Promise<RotateResult> {
      const row = ports.get(portKey);
      if (!row) return { changed: false, noteKey: 'main.rotateResult.unchangedNote' };
      const target = findTarget(row.locationKey);
      const from = row.state.kind === 'online' ? row.state.exitIp : row.serverIp;

      const moveTo = (server: string) => {
        pin(row, server);
        row.enabled = true;
        health.set(server, { health: 'ok', lastOk: Date.now() });
        row.state = { kind: 'online', since: Date.now(), exitIp: row.serverIp!, country: row.country, latencyMs: 48 };
      };

      // An explicit pick from the Change-IP menu must be a free usable server of this location.
      if (toServer !== undefined) {
        const ok = target?.servers.includes(toServer) && usable(toServer) && !holderOf(toServer);
        if (!ok) return { changed: false, from, noteKey: 'main.rotateResult.serverTaken' };
        moveTo(toServer);
        emitPorts();
        return { changed: true, from, to: row.serverIp };
      }

      // §6.5 step 1: the best free server of the same location.
      const next = target ? freeServersOf(target)[0] : undefined;
      if (next) {
        moveTo(next);
        emitPorts();
        return { changed: true, from, to: row.serverIp };
      }

      // §6.5 step 2: otherwise another location in the same country; the port
      // moves to that location's group (and so gets a key there).
      const sibling = target
        ? SAMPLE_TARGETS.find(
            (t) =>
              t.providerId === target.providerId &&
              t.country === target.country &&
              t.key !== target.key &&
              freeServersOf(t).length > 0,
          )
        : undefined;
      if (sibling) {
        const server = freeServersOf(sibling)[0];
        ports.delete(row.key);
        row.key = makePortKey(sibling.key, nextN(sibling.key));
        row.locationKey = sibling.key;
        row.city = sibling.city;
        row.label = sibling.label;
        ports.set(row.key, row);
        moveTo(server);
        emitPorts();
        return { changed: true, from, to: row.serverIp, noteKey: 'main.rotateResult.sameCityNote', movedTo: row.city };
      }

      // §6.5 step 3: no other server available.
      return { changed: false, from, noteKey: 'main.rotateResult.unchangedNote' };
    },

    async setAutoRotate(targetKey, minutes) {
      const row = ports.get(targetKey);
      if (row) row.autoRotateMin = minutes;
      emitPorts();
    },

    async setLimit(providerId, limit) {
      // Write-only in the fake (contracts has no getLimit) — stored so a
      // second call / a future getter could observe it, but nothing reads
      // this map today.
      limits.set(providerId, limit);
    },

    async testPort(targetKey, speed) {
      const row = ports.get(targetKey);
      if (!row || row.state.kind !== 'online') {
        return { ok: false };
      }
      return { ok: true, exitIp: row.state.exitIp, latencyMs: row.state.latencyMs, mbps: speed ? 42.5 : undefined };
    },

    async getLogs(targetKey) {
      const n = (logCounters.get(targetKey) ?? 0) + 1;
      logCounters.set(targetKey, n);
      return [`[fake] log line ${n} for ${targetKey}`, `[fake] no real sing-box process backs this port in the dev fallback`];
    },

    async exportPorts(targetKeys, format: ExportFormat) {
      const rows = targetKeys.map((k) => ports.get(k)).filter((r): r is PortRow => Boolean(r));
      const lines = rows.map((row) => {
        const host = '127.0.0.1';
        switch (format) {
          case 'hostPortUserPass':
            return `${host}:${row.proxyPort}:${settings.proxyUser}:${settings.proxyPass}`;
          case 'socks5Url':
            return `socks5://${settings.proxyUser}:${settings.proxyPass}@${host}:${row.proxyPort}`;
          case 'hostPort':
            return `${host}:${row.proxyPort}`;
          case 'curl':
            return `curl -x socks5h://${settings.proxyUser}:${settings.proxyPass}@${host}:${row.proxyPort} https://example.com`;
          default:
            return `${host}:${row.proxyPort}`;
        }
      });
      return lines.join('\n');
    },

    async getSettings() {
      return { ...settings };
    },

    async setSettings(patch) {
      settings = { ...settings, ...patch };
      return { ...settings };
    },

    async getHostVpnActive() {
      return hostVpnActive;
    },

    async getAppStatus() {
      return { secretsUnavailable: false };
    },

    async getUpdateStatus() {
      return updateStatus;
    },

    async checkForUpdate() {
      // The dev/standalone fake has no real feed: simulate a quick "up to date" check.
      emitUpdateStatus({ phase: 'checking', currentVersion: appVersion });
      emitUpdateStatus({ phase: 'up-to-date', currentVersion: appVersion });
      return updateStatus;
    },

    async downloadAndInstallUpdate() {
      // No real installer in the fake; just report success without quitting.
      return { success: true };
    },

    async getDiagnostics() {
      // Same shape and redaction as main's collectDiagnostics: ids and counts only.
      const rows = [...ports.values()];
      return {
        appVersion,
        os: { platform: 'fake', release: '0', arch: 'fake' },
        versions: { electron: 'fake', chrome: 'fake', node: 'fake' },
        singBox: '1.14.2',
        providers: (['hma', 'zoogvpn', 'surfshark', 'file'] as ProviderId[]).map((id) => {
          const own = rows.filter((r) => r.providerId === id);
          const portStates: Partial<Record<PortRow['state']['kind'], number>> = {};
          for (const r of own) portStates[r.state.kind] = (portStates[r.state.kind] ?? 0) + 1;
          return { id, accounts: accounts.filter((a) => a.account.providerId === id).length, ports: own.length, portStates };
        }),
      };
    },

    onPortsChanged(cb) {
      portsListeners.add(cb);
      return () => portsListeners.delete(cb);
    },

    onHostVpnChanged(cb) {
      hostVpnListeners.add(cb);
      return () => hostVpnListeners.delete(cb);
    },

    onUpdateStatus(cb) {
      updateStatusListeners.add(cb);
      return () => updateStatusListeners.delete(cb);
    },

    __setHostVpnActive(active) {
      hostVpnActive = active;
      emitHostVpn();
    },
  };

  return api;
}

// Re-exported so components can type fake-aware props without importing
// electron-shaped globals.
export type { CheckResult };
