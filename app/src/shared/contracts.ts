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
  /**
   * The location's server pool, best first (spec §6.8). Each entry is one server = one
   * fixed exit IP: an IP literal (HMA, pinned Surfshark pool IPs) or a hostname
   * (ZoogVPN, file remotes) that the controller resolves before bind.
   */
  servers: string[];
  /**
   * The provider's hostnames are DNS round-robin pools (Surfshark clusters before their
   * pool IPs are discovered): one hostname token may stand for many servers, so a port
   * pinned to it does not use it up. IP literals in `servers` are unaffected. Optional;
   * absent means every token is one server.
   */
  poolHostnames?: boolean;
  /** Filled by the controller in `listTargets`: usable servers not held by any port. */
  freeServers?: number;
}

/** Health of one server for one account (spec §6.8). */
export type ServerHealth = 'ok' | 'unknown' | 'refused' | 'dead';

/** One server of a location's pool, as shown in the Change-IP menu (spec §4.1, §6.8). */
export interface ServerInfo {
  /** Pool token (IP literal or hostname). */
  server: string;
  /** Resolved IP, when known. */
  ip?: string;
  health: ServerHealth;
  /** Epoch ms the server was last confirmed online. */
  lastOk?: number;
  /** Key of the port currently pinned to this server, if any. */
  heldBy?: string;
}

/** Separator between a location key and a port number in a port key (spec §6.8). */
export const PORT_KEY_SEPARATOR = '#';

/** `<locationKey>#<n>`, n ≥ 1. */
export function makePortKey(locationKey: string, n: number): string {
  return `${locationKey}${PORT_KEY_SEPARATOR}${n}`;
}

/** Inverse of `makePortKey`; undefined for a bare location key (pre-rev-3 key or webhook alias). */
export function splitPortKey(key: string): { locationKey: string; n: number } | undefined {
  const at = key.lastIndexOf(PORT_KEY_SEPARATOR);
  if (at <= 0) return undefined;
  const n = Number(key.slice(at + 1));
  if (!Number.isInteger(n) || n < 1) return undefined;
  return { locationKey: key.slice(0, at), n };
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
  /** Check for app updates on start and once a day while running (default true). When
   * off, no automatic/periodic check runs; the user can still check + install manually
   * from the Settings screen. Download+install is always user-initiated (autoDownload is
   * off), so there is no separate auto-INSTALL toggle. */
  autoCheckUpdates: boolean;
}

export interface PortRow {
  /** Port key `<locationKey>#<n>` (spec §6.8). Several ports may share a location. */
  key: string;
  /** The location (`Target.key`) this port belongs to. */
  locationKey: string;
  /** Pinned server token (spec §6.8); undefined until the port's first start. */
  server?: string;
  /** The pinned server's resolved IP, when known. */
  serverIp?: string;
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

export interface AppStatus {
  /** `safeStorage` encryption unavailable: secrets live in memory for this session only. */
  secretsUnavailable: boolean;
  /** Set when the bundled sing-box is missing, quarantined, or the wrong version. */
  engineError?: string;
  /** A one-time human-readable notice (e.g. the proxy password had to be reset). */
  notice?: string;
}

// ───────────────────────── auto-update (electron-updater) ─────────────────────────

/**
 * Updater state pushed to the renderer (and returned by `checkForUpdate`). A single flat
 * shape keeps it trivial to serialise across IPC and to assert on in tests:
 *   idle        — no check has completed yet this session
 *   checking    — a check is in flight
 *   up-to-date  — the running build is the latest (also the "no published channel file
 *                 yet" case: that is not an error, it means there is nothing newer)
 *   available   — a newer version exists; `availableVersion` is set, download not started
 *   downloading — `percent` is the download progress 0..100
 *   downloaded  — fully downloaded; a restart will install `availableVersion`
 *   error       — `message` + `releasesUrl` (manual-download fallback to GitHub Releases)
 * `currentVersion` is always the running app's version.
 */
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  percent?: number;
  message?: string;
  releasesUrl?: string;
}

// ───────────────────────── IPC surface exposed as `window.proxyFarm` (spec §3) ─────────────────────────

export interface ProxyFarmApi {
  // providers & accounts
  /** `limit` is the provider's current port limit (0 = unlimited; integration Ruling C). */
  listProviders(): Promise<
    Array<{ id: ProviderId; accounts: Account[]; detected?: { found: boolean; hintKey?: string }; limit?: number }>
  >;
  addAccount(providerId: ProviderId, input: Record<string, string>): Promise<CheckResult & { account?: Account }>;
  removeAccount(accountId: string): Promise<void>;
  /** HMA: (re)import device credentials from the local HMA install. */
  connectHma(): Promise<CheckResult & { account?: Account }>;
  /** Windows only: runs the elevated helper installer (spec §7, one UAC). Shown when `detected.hintKey`
   * says the helper is missing. Stubbed until the Windows track: returns `{ok:false, reasonKey:'hma.windowsLater'}`. */
  enableHmaSupport(): Promise<CheckResult>;
  importConfigFile(name: string, content: string, country?: string): Promise<CheckResult & { account?: Account }>;
  /** Locations with `freeServers` filled in (spec §6.8). */
  listTargets(providerId?: ProviderId): Promise<Target[]>;

  // ports (keys are port keys `<locationKey>#<n>` unless stated otherwise)
  listPorts(): Promise<PortRow[]>;
  /** Adds up to `count` ports to a location, each on a different free usable server, and
   * starts them. `added` may be shorter than `count`; `noteKey` then says why
   * ('no-free-server' | 'limit-reached'). */
  addPorts(locationKey: string, count: number): Promise<{ added: PortRow[]; noteKey?: string }>;
  /** The location's server pool with health and which port holds each server. */
  listServers(locationKey: string): Promise<ServerInfo[]>;
  /** Starts existing ports. A bare location key (no `#n`) is accepted for compatibility
   * and means "add one port to that location". */
  startPorts(portKeys: string[]): Promise<void>;
  stopPorts(portKeys: string[]): Promise<void>;
  removePorts(portKeys: string[]): Promise<void>;
  /** Change IP (spec §6.5): move the port to another free server of its location, or to
   * `toServer` when given (must be a free usable server of the same location). */
  rotatePort(portKey: string, toServer?: string): Promise<RotateResult>;
  setAutoRotate(targetKey: string, minutes: number): Promise<void>;
  setLimit(providerId: ProviderId, limit: number): Promise<void>;
  testPort(targetKey: string, speed: boolean): Promise<{ ok: boolean; exitIp?: string; latencyMs?: number; mbps?: number }>;
  getLogs(targetKey: string): Promise<string[]>;
  exportPorts(targetKeys: string[], format: ExportFormat): Promise<string>;

  // settings & environment
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getHostVpnActive(): Promise<boolean>;
  /** App-level health the UI must surface: engine missing/quarantined (blocking error
   * screen), secrets kept in memory only (safeStorage unavailable), one-time notices. */
  getAppStatus(): Promise<AppStatus>;

  // auto-update (electron-updater; download+install is always user-initiated)
  /** The latest updater status WITHOUT triggering a check. The renderer calls this on
   * mount to seed its UI: the startup/periodic check fires before React mounts and
   * Electron does not buffer `webContents.send`, so a result found at startup would
   * otherwise be invisible until a manual check or the next daily tick. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Trigger a check now and resolve with the resulting status. */
  checkForUpdate(): Promise<UpdateStatus>;
  /** Download the available update, stop every running engine, then quit & install.
   * Resolves (`{success:true}`) once the download finished and install was scheduled. */
  downloadAndInstallUpdate(): Promise<{ success: boolean; error?: string }>;

  // push events (return an unsubscribe fn)
  onPortsChanged(cb: (rows: PortRow[]) => void): () => void;
  onHostVpnChanged(cb: (active: boolean) => void): () => void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}

/** Channel names used by preload ↔ main. Preload exposes exactly these, nothing else. */
export const IPC = {
  invoke: [
    'listProviders', 'addAccount', 'removeAccount', 'connectHma', 'enableHmaSupport', 'importConfigFile', 'listTargets',
    'listPorts', 'addPorts', 'listServers', 'startPorts', 'stopPorts', 'removePorts', 'rotatePort', 'setAutoRotate', 'setLimit',
    'testPort', 'getLogs', 'exportPorts', 'getSettings', 'setSettings', 'getHostVpnActive', 'getAppStatus',
    'getUpdateStatus', 'checkForUpdate', 'downloadAndInstallUpdate',
  ] as const,
  events: { portsChanged: 'pf:portsChanged', hostVpnChanged: 'pf:hostVpnChanged', updateStatus: 'pf:updateStatus' } as const,
} as const;

declare global {
  interface Window {
    proxyFarm: ProxyFarmApi;
  }
}
