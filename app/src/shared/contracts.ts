/**
 * Shared contracts for Proxy Farm v2 (spec: docs/superpowers/specs/2026-10-07-desktop-app-design.md).
 *
 * Several modules are built in parallel against this file. Change it only by
 * agreement: every exported name here is relied on by at least two modules.
 *   engine/     renderConfig, invariants, ports, supervisor, pid registry   (spec §6.1–6.3)
 *   health/     log signals, /delay, exit-IP, state machine, backoff        (spec §6.4)
 *   providers/  hma, zoogvpn, surfshark, file + catalogs                    (spec §5)
 *   controller/ store, accounts, port manager, power, webhook, IPC          (spec §3, §4, §6.5–6.7)
 *   renderer/   React UI + i18n, talks only to `window.proxyFarm`           (spec §4)
 */

// ───────────────────────── sing-box endpoint specs (spec §5, §6.1) ─────────────────────────

/** The single endpoint of a port's sing-box config. Its tag is always ENDPOINT_TAG. */
export const ENDPOINT_TAG = 'ep';

export interface OpenVpnEndpoint {
  type: 'openvpn-client';
  server: string; // IP literal only — hostnames are resolved by the controller first (§6.1.4)
  server_port: number;
  network: 'udp' | 'tcp';
  username?: string;
  password?: string;
  tls: {
    certificate: string[]; // inline PEM lines (never a path — §6.1.1)
    server_name?: string;
    remote_certificate_tls?: 'server';
    control_wrap?: {
      type: 'tls_auth' | 'tls_crypt';
      key: string[]; // inline key lines
      direction?: 'client';
    };
  };
  data_ciphers: string[];
  data_ciphers_fallback?: string;
  auth?: string; // e.g. 'SHA256'
  route_no_pull: true;
  explicit_exit_notify?: number;
  mtu: number;
}

export interface WireguardEndpoint {
  type: 'wireguard';
  address: string[]; // e.g. ['10.14.0.2/16']
  private_key: string;
  mtu: number;
  peers: Array<{
    address: string; // IP literal
    port: number;
    public_key: string;
    pre_shared_key?: string;
    allowed_ips: string[];
    persistent_keepalive_interval?: number;
  }>;
}

export type EndpointSpec = OpenVpnEndpoint | WireguardEndpoint;

export interface RenderInput {
  endpoint: EndpointSpec;
  listen: { host: '127.0.0.1' | '0.0.0.0'; port: number; proxyAuth?: { username: string; password: string } };
  clash: { port: number; secret: string };
}

// ───────────────────────── providers & catalogs (spec §5) ─────────────────────────

export type ProviderId = 'hma' | 'zoogvpn' | 'surfshark' | 'file';

/** One selectable exit location. `key` is stable across catalog refreshes. */
export interface Target {
  key: string; // e.g. 'hma:JP-40-TOKYO-ULT', 'surfshark:jp-tok', 'file:<id>'
  providerId: ProviderId;
  country: string; // ISO-3166 alpha-2, upper case
  city: string;
  label: string;
  /** Candidate server IPs for this location, best first (§5.1 catalog `ips`). */
  servers: string[];
}

export interface Account {
  id: string; // e.g. 'hma-1'
  providerId: ProviderId;
  label: string;
  /** Non-secret metadata only. Secrets live in the secrets store under `secretRef`. */
  meta: Record<string, string>;
  secretRef: string;
}

/** Decrypted credentials handed to a provider's `bind` (never persisted in plain text). */
export type AccountSecret =
  | { kind: 'userpass'; username: string; password: string }
  | { kind: 'wgkey'; privateKey: string }
  | { kind: 'file'; content: string; username?: string; password?: string };

export interface CheckResult {
  ok: boolean;
  reasonKey?: string; // i18n key
  label?: string; // human label for the account, e.g. 'key …AbC='
}

export interface Provider {
  id: ProviderId;
  /** Validate user input (format only, no network) and normalise it. */
  check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> };
  /** All locations this account can use. Pure over the given catalog. */
  targets(account: Account): Promise<Target[]>;
  /** Build the endpoint for one server of one target. Pure. */
  bind(target: Target, serverIp: string, account: Account, secret: AccountSecret): EndpointSpec;
}

// ───────────────────────── engine / health (spec §6.3–6.4) ─────────────────────────

export type LogSignal = 'established' | 'auth-terminal';

export type DelayResult = { code: 200; ms: number } | { code: 503 } | { code: 504 } | { code: 'error'; message: string };

export type FailReason = 'auth' | 'not-in-plan' | 'port-in-use' | 'no-server';

export type PortState =
  | { kind: 'queued' }
  | { kind: 'connecting'; since: number }
  | { kind: 'verifying'; since: number }
  | { kind: 'online'; since: number; exitIp: string; country: string; latencyMs?: number }
  | { kind: 'retrying'; untilMs: number; attempt: number; reasonKey: string }
  | { kind: 'failed'; reason: FailReason; untilMs: number; attempt: number }
  | { kind: 'stopped' };

export interface ExitIpResult {
  ip: string;
  country: string;
}

// ───────────────────────── settings & ports (spec §4.2, §6.2, §6.6) ─────────────────────────

export interface Settings {
  proxyUser: string;
  proxyPass: string; // auto-generated on first run (§4.2)
  basePort: number; // default 29001
  lanSharing: boolean; // default false (§6.2)
  keepAwake: boolean; // default true (§4.3)
  launchAtLogin: boolean; // default false
  giveUpAfter: number; // 0 = never (default)
  webhook: { enabled: boolean; port: number; bearer: string }; // off by default (§6.6)
  language: 'en' | 'vi' | 'system';
}

export interface PortRow {
  key: string; // Target.key
  providerId: ProviderId;
  accountId: string;
  label: string;
  country: string;
  city: string;
  proxyPort: number;
  enabled: boolean;
  state: PortState;
  autoRotateMin: number; // 0 = off
}

export type ExportFormat = 'hostPortUserPass' | 'socks5Url' | 'hostPort' | 'curl';

export interface RotateResult {
  changed: boolean;
  from?: string;
  to?: string;
  /** set when changed === false, or when rotation moved to another city (§6.5) */
  noteKey?: string;
}

// ───────────────────────── IPC surface exposed as `window.proxyFarm` (spec §3) ─────────────────────────

export interface ProxyFarmApi {
  // providers & accounts
  listProviders(): Promise<Array<{ id: ProviderId; accounts: Account[]; detected?: { found: boolean; hintKey?: string } }>>;
  addAccount(providerId: ProviderId, input: Record<string, string>): Promise<CheckResult & { account?: Account }>;
  removeAccount(accountId: string): Promise<void>;
  /** HMA: (re)import device credentials from the local HMA install. */
  connectHma(): Promise<CheckResult & { account?: Account }>;
  importConfigFile(name: string, content: string): Promise<CheckResult & { account?: Account }>;
  listTargets(providerId?: ProviderId): Promise<Target[]>;

  // ports
  listPorts(): Promise<PortRow[]>;
  startPorts(targetKeys: string[]): Promise<void>;
  stopPorts(targetKeys: string[]): Promise<void>;
  removePorts(targetKeys: string[]): Promise<void>;
  rotatePort(targetKey: string): Promise<RotateResult>;
  setAutoRotate(targetKey: string, minutes: number): Promise<void>;
  setLimit(providerId: ProviderId, limit: number): Promise<void>;
  testPort(targetKey: string, speed: boolean): Promise<{ ok: boolean; exitIp?: string; latencyMs?: number; mbps?: number }>;
  getLogs(targetKey: string): Promise<string[]>;
  exportPorts(targetKeys: string[], format: ExportFormat): Promise<string>;

  // settings & environment
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getHostVpnActive(): Promise<boolean>;

  // push events (return an unsubscribe fn)
  onPortsChanged(cb: (rows: PortRow[]) => void): () => void;
  onHostVpnChanged(cb: (active: boolean) => void): () => void;
}

/** Channel names used by preload ↔ main. Preload exposes exactly these, nothing else. */
export const IPC = {
  invoke: [
    'listProviders', 'addAccount', 'removeAccount', 'connectHma', 'importConfigFile', 'listTargets',
    'listPorts', 'startPorts', 'stopPorts', 'removePorts', 'rotatePort', 'setAutoRotate', 'setLimit',
    'testPort', 'getLogs', 'exportPorts', 'getSettings', 'setSettings', 'getHostVpnActive',
  ] as const,
  events: { portsChanged: 'pf:portsChanged', hostVpnChanged: 'pf:hostVpnChanged' } as const,
} as const;

declare global {
  interface Window {
    proxyFarm: ProxyFarmApi;
  }
}
