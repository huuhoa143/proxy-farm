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
  Settings,
  Target,
} from '../shared/contracts';

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

const SAMPLE_TARGETS: Target[] = [
  makeTarget('hma:JP-TOKYO', 'hma', 'JP', 'Tokyo', ['203.0.113.10', '203.0.113.11']),
  makeTarget('hma:US-NYC', 'hma', 'US', 'New York', ['203.0.113.20']),
  makeTarget('hma:SG-SIN', 'hma', 'SG', 'Singapore', ['203.0.113.30']),
  makeTarget('zoogvpn:NL-AMS', 'zoogvpn', 'NL', 'Amsterdam', ['198.51.100.10']),
  makeTarget('zoogvpn:VN-HAN', 'zoogvpn', 'VN', 'Hanoi', ['198.51.100.20']),
  makeTarget('surfshark:DE-FRA', 'surfshark', 'DE', 'Frankfurt', ['192.0.2.10', '192.0.2.11']),
  // Appended (not inserted) so the index-based sample-port wiring below keeps
  // pointing at the same targets. Gives hma:US-NYC a same-country sibling to
  // exercise rotate's "moved to another city" path (spec §6.5 step 2).
  makeTarget('hma:US-LA', 'hma', 'US', 'Los Angeles', ['203.0.113.21']),
];

function samplePortRow(target: Target, accountId: string, proxyPort: number, state: PortRow['state']): PortRow {
  return {
    key: target.key,
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
    language: 'system',
  };

  let hostVpnActive = false;
  const limits = new Map<ProviderId, number>();
  const logCounters = new Map<string, number>();

  const ports = new Map<string, PortRow>([
    [SAMPLE_TARGETS[0].key, samplePortRow(SAMPLE_TARGETS[0], 'hma-1', 29001, {
      kind: 'online',
      since: now - 5 * 60_000,
      exitIp: SAMPLE_TARGETS[0].servers[0],
      country: SAMPLE_TARGETS[0].country,
      latencyMs: 42,
    })],
    [SAMPLE_TARGETS[1].key, samplePortRow(SAMPLE_TARGETS[1], 'hma-1', 29002, {
      kind: 'retrying',
      untilMs: now + 30_000,
      attempt: 2,
      reasonKey: 'portState.failed.no-server.guidance',
    })],
    [SAMPLE_TARGETS[3].key, samplePortRow(SAMPLE_TARGETS[3], 'zoogvpn-1', 29003, {
      kind: 'failed',
      reason: 'auth',
      untilMs: now + 30 * 60_000,
      attempt: 5,
    })],
    [SAMPLE_TARGETS[5].key, samplePortRow(SAMPLE_TARGETS[5], 'zoogvpn-1', 29004, { kind: 'stopped' })],
  ]);

  const portsListeners = new Set<Listener<PortRow[]>>();
  const hostVpnListeners = new Set<Listener<boolean>>();

  function emitPorts(): void {
    const rows = Array.from(ports.values());
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

  async function simulateConnect(key: string): Promise<void> {
    const row = ports.get(key);
    if (!row) return;
    row.state = { kind: 'connecting', since: Date.now() };
    row.enabled = true;
    emitPorts();
    row.state = { kind: 'verifying', since: Date.now() };
    emitPorts();
    const target = SAMPLE_TARGETS.find((t) => t.key === key);
    row.state = {
      kind: 'online',
      since: Date.now(),
      exitIp: target?.servers[0] ?? '203.0.113.99',
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
      return providerId ? SAMPLE_TARGETS.filter((t) => t.providerId === providerId) : SAMPLE_TARGETS;
    },

    async listPorts() {
      return Array.from(ports.values());
    },

    async startPorts(targetKeys) {
      for (const key of targetKeys) {
        let row = ports.get(key);
        if (!row) {
          const target = SAMPLE_TARGETS.find((t) => t.key === key);
          if (!target) continue;
          const account = accounts.find((a) => a.account.providerId === target.providerId)?.account;
          row = samplePortRow(target, account?.id ?? 'unknown', nextPort(), { kind: 'queued' });
          ports.set(key, row);
        }
        row.state = { kind: 'queued' };
        emitPorts();
        await simulateConnect(key);
      }
    },

    async stopPorts(targetKeys) {
      for (const key of targetKeys) {
        const row = ports.get(key);
        if (row) {
          row.state = { kind: 'stopped' };
          row.enabled = false;
        }
      }
      emitPorts();
    },

    async removePorts(targetKeys) {
      for (const key of targetKeys) ports.delete(key);
      emitPorts();
    },

    async rotatePort(targetKey): Promise<RotateResult> {
      const row = ports.get(targetKey);
      if (!row || row.state.kind !== 'online') {
        return { changed: false, noteKey: 'main.rotateResult.unchangedNote' };
      }
      const target = SAMPLE_TARGETS.find((t) => t.key === targetKey);
      const from = row.state.exitIp;

      // §6.5 step 1: another IP of the same location.
      const sameLocationIp = target?.servers.find((ip) => ip !== from);
      if (sameLocationIp) {
        row.state = { kind: 'online', since: Date.now(), exitIp: sameLocationIp, country: row.country, latencyMs: 48 };
        emitPorts();
        return { changed: true, from, to: sameLocationIp };
      }

      // §6.5 step 2: otherwise another location in the same country.
      const sibling = target
        ? SAMPLE_TARGETS.find((t) => t.providerId === target.providerId && t.country === target.country && t.key !== target.key)
        : undefined;
      if (sibling) {
        const to = sibling.servers[0];
        row.city = sibling.city;
        row.label = sibling.label;
        row.state = { kind: 'online', since: Date.now(), exitIp: to, country: row.country, latencyMs: 48 };
        emitPorts();
        return { changed: true, from, to, noteKey: 'main.rotateResult.sameCityNote' };
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

    onPortsChanged(cb) {
      portsListeners.add(cb);
      return () => portsListeners.delete(cb);
    },

    onHostVpnChanged(cb) {
      hostVpnListeners.add(cb);
      return () => hostVpnListeners.delete(cb);
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
