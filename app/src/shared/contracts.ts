/**
 * Shared contracts for Proxy Farm v2 (spec: docs/superpowers/specs/2026-10-07-desktop-app-design.md).
 *
 * Several modules are built in parallel against this file. Change it only by
 * agreement: every exported name here is relied on by at least two modules.
 *   engine/     renderConfig, invariants, ports, supervisor, pid registry   (spec §6.1–6.3)
 *   health/     log signals, /delay, exit-IP, state machine, backoff        (spec §6.4)
 *   providers/  hma, zoogvpn, surfshark, nordvpn, expressvpn, file + catalogs (spec §5)
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
    /** How `server_name` is matched against the server certificate (OpenVPN
     * `verify-x509-name <name> <type>`); sing-box's default is the full subject. */
    server_name_type?: 'subject' | 'name' | 'name-prefix';
    /** Client-certificate auth (OpenVPN `<cert>` / `<key>`): inline PEM lines, both or neither. */
    client_certificate?: string[];
    client_key?: string[];
    remote_certificate_tls?: 'server';
    /** OpenVPN `ns-cert-type server`: the legacy Netscape check on the server certificate. */
    ns_certificate_type?: 'server';
    control_wrap?: {
      type: 'tls_auth' | 'tls_crypt';
      key: string[]; // inline key lines
      direction?: 'client';
    };
  };
  data_ciphers: string[];
  data_ciphers_fallback?: string;
  auth?: string; // e.g. 'SHA256'
  /** OpenVPN `fragment N`: split data packets above N bytes. A server configured with it
   * needs the client to match, or the tunnel comes up and carries nothing (ExpressVPN). */
  fragment?: number;
  /** OpenVPN `mssfix N`. */
  mss_fix?: number;
  /** OpenVPN `comp-lzo no`: compression framing on, compression off. */
  compression_lzo?: 'no';
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

export type ProviderId = 'hma' | 'zoogvpn' | 'surfshark' | 'nordvpn' | 'expressvpn' | 'file';

/**
 * A provider's port limit when the user has not set one (spec §6.8); absent = 0 =
 * unlimited. An explicit user value, 0 included, always wins. ExpressVPN: a plan allows
 * 10 devices at once; 8 leaves 2 for the user's own devices (spec §5.6).
 */
export const DEFAULT_PORT_LIMITS: Partial<Record<ProviderId, number>> = { nordvpn: 6, expressvpn: 8 };

/** The port limit in force for a provider: the user's, else the default, else 0. */
export function portLimitOf(limits: Partial<Record<ProviderId, number>>, providerId: ProviderId): number {
  return limits[providerId] ?? DEFAULT_PORT_LIMITS[providerId] ?? 0;
}

/**
 * How a provider's exit IP relates to the server a port pins (spec §5, §6.8):
 *   server   — one exit per server, for good: the server's own IP (HMA, ZoogVPN) or
 *              another IP that server always uses (ExpressVPN: .69 always exits as .47).
 *              Either way an exit seen once identifies the server.
 *   server+1 — the server's IP + 1, stable per server (Surfshark).
 *   session  — chosen when the tunnel connects: fixed while it stays connected, but a
 *              new connection to the same server may get another one (NordVPN). Also
 *              the safe assumption for an imported file, whose provider is unknown.
 * For `session` providers an exit seen once says nothing about the server's next
 * session: it is not a server identity, and a different exit after a reconnect is
 * normal, never an error.
 */
export type ExitIpModel = 'server' | 'server+1' | 'session';

/** Static per provider, like `DEFAULT_PORT_LIMITS`: main and the renderer both read it. */
export const EXIT_IP_MODELS: Record<ProviderId, ExitIpModel> = {
  hma: 'server',
  zoogvpn: 'server',
  surfshark: 'server+1',
  nordvpn: 'session',
  expressvpn: 'server',
  file: 'session',
};

/** One selectable exit location. `key` is stable across catalog refreshes. */
export interface Target {
  key: string; // e.g. 'hma:JP-40-TOKYO-ULT', 'surfshark:jp-tok', 'file:<id>'
  providerId: ProviderId;
  country: string; // ISO-3166 alpha-2, upper case
  city: string;
  label: string;
  /** The location covers the whole country: `city` is only the country's name, in the
   * provider's language (ZoogVPN "Germany"). The UI shows the localised country name. */
  countryWide?: boolean;
  /**
   * The provider marks the location virtual: its servers stand in another country and
   * only present as `country` (NordVPN's `virtual_location`, Surfshark's `virtual` tag).
   * `country` is still what the location is sold as, and what the UI tags its exits
   * with. Optional; absent = not marked.
   */
  virtualLocation?: boolean;
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
  /**
   * Servers of `servers` on the provider's free tier: any valid login may use them,
   * whatever its plan, so a handshake there checks the credentials alone (spec §5.2,
   * ZoogVPN `*.zgfree.info`). Optional; absent means none.
   */
  freeTierServers?: string[];
  /** Filled by the controller in `listTargets`: usable servers not held by any port. */
  freeServers?: number;
  /**
   * Filled by the controller in `listTargets`: every server of the location has refused
   * every account of its provider (spec §6.8, §5.2) — the location is not in the user's
   * plan(s). Absent otherwise.
   */
  notInPlan?: boolean;
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
  /** On the provider's free tier (`Target.freeTierServers`): usable on any plan. */
  freeTier?: boolean;
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
  label?: string; // human label for the account, e.g. 'pubkey …qqbTmo' (never from a secret)
  /** i18n key of a caveat on an accepted result, e.g. the login could not be checked
   * live right now ('zoogvpn.check.unverified'). */
  noteKey?: string;
}

export interface Provider {
  id: ProviderId;
  /**
   * Optional network step that runs once, before `check`, when an account is added
   * (spec §5.5: NordVPN exchanges an access token for the account's NordLynx key).
   * Resolves to the input `check` should validate instead, or to a refusal (an i18n
   * key). Never rejects. Providers without it get their input checked as typed.
   */
  resolveInput?(input: Record<string, string>): Promise<{ input: Record<string, string> } | { reasonKey: string }>;
  /**
   * The provider has no plans that limit servers: every server takes every valid login,
   * so one test connection to any server checks the credentials (spec §5.6, ExpressVPN).
   * Unlike a free tier (`Target.freeTierServers`) this tells the credential probe where
   * it may ask; an auth failure still just means the login is wrong. Absent = false.
   */
  anyServerChecksLogin?: boolean;
  /** Validate user input (format only, no network) and normalise it. */
  check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> };
  /** All locations this account can use. Pure over the given catalog. */
  targets(account: Account): Promise<Target[]>;
  /** Build the endpoint for one server of one target. Pure. */
  bind(target: Target, serverIp: string, account: Account, secret: AccountSecret): EndpointSpec;
}

// ───────────────────────── engine / health (spec §6.3–6.4) ─────────────────────────

export type LogSignal = 'established' | 'auth-terminal';

/** `timedOut` on an error: clash_api did not answer at all within the client's hard timeout
 * (a wedged or frozen engine), as opposed to answering with an error or refusing the connection. */
export type DelayResult = { code: 200; ms: number } | { code: 503 } | { code: 504 } | { code: 'error'; message: string; timedOut?: boolean };

/**
 * `key-rejected`: a WireGuard key that has never completed a handshake got no answer on
 * several attempts in a row, so the app stopped trying (spec §6.4 "Provider safety").
 * Unlike every other reason it is not retried automatically at all: only a user Start or
 * Change IP tries again.
 */
export type FailReason = 'auth' | 'not-in-plan' | 'port-in-use' | 'no-server' | 'key-rejected';

/**
 * What the app found out about a failure, beyond its reason (spec §5.2):
 *   wrong-credentials    — `auth`: a free-tier server refused the login too, so the
 *                          email/password are wrong (not the plan).
 *   unverified-login     — `auth`: several servers refused the login and no free-tier
 *                          server could be reached to tell a wrong password from the plan.
 *   location-not-in-plan — `not-in-plan`: every server of the location refused an
 *                          account whose login works.
 */
export type FailDetail = 'wrong-credentials' | 'unverified-login' | 'location-not-in-plan';

/**
 * Failures retrying cannot fix: the provider refused the login, the plan does not
 * include the location's servers, or a WireGuard key got no answer. Nothing restarts
 * such a port automatically (no timer, no engine) until the user acts: Start, Change
 * IP, or new credentials. `port-in-use` and `no-server` are transient and keep retrying.
 */
export function isTerminalFailure(reason: FailReason): boolean {
  return reason === 'auth' || reason === 'not-in-plan' || reason === 'key-rejected';
}

/** True for a `failed` state that is terminal (see `isTerminalFailure`). */
export function isTerminalState(state: PortState): boolean {
  return state.kind === 'failed' && isTerminalFailure(state.reason);
}

export type PortState =
  | { kind: 'queued' }
  | { kind: 'connecting'; since: number }
  | { kind: 'verifying'; since: number }
  | { kind: 'online'; since: number; exitIp: string; country: string; latencyMs?: number }
  | { kind: 'retrying'; untilMs: number; attempt: number; reasonKey: string }
  | { kind: 'failed'; reason: FailReason; untilMs: number; attempt: number; detail?: FailDetail }
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
  /** The version of the first-run disclaimer notice the user acknowledged ("I
   * understand"); 0 = never. The notice shows while this is below
   * `DISCLAIMER_NOTICE_VERSION`, so bumping that constant re-shows it once. A state
   * file from before this field existed loads as 0: existing users see it once too. */
  acknowledgedDisclaimer: number;
}

/** Bump when the first-run disclaimer notice changes in substance. */
export const DISCLAIMER_NOTICE_VERSION = 1;

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
  /** Set whenever Change IP moved the port to another location of the same country
   * (§6.5 step 2): that location's city. Reported even when `changed` is false (the new
   * exit IP could not be confirmed), so the move is never silent. */
  movedTo?: string;
  /** Set when the server Change IP moved the port to refused its account (not in the
   * plan, another tenant's server): that server. The port does not stay on it. */
  refusedServer?: string;
  /** With `refusedServer`: the server the port went to instead, once it was online
   * again (the one it was on before when still usable). Absent when it found none. */
  landedOn?: string;
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
 *   error       — `errorKey` + raw `message` + `releasesUrl` (manual-download fallback to GitHub Releases)
 * `currentVersion` is always the running app's version.
 */
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  percent?: number;
  /** The raw updater error (English, for a details tooltip / bug reports). */
  message?: string;
  /** What kind of failure `message` is, so the renderer can show a localised sentence. */
  errorKey?: UpdateErrorKey;
  releasesUrl?: string;
}

/**
 * Known updater failures (`settings.update.errors.<key>` in the renderer):
 *   no-releases     — the release feed has no published version yet
 *   network         — GitHub could not be reached (offline, DNS, timeout, TLS)
 *   no-auto-update  — this build cannot auto-update (missing app-update.yml)
 *   generic         — anything else
 */
export type UpdateErrorKey = 'no-releases' | 'network' | 'no-auto-update' | 'generic';

// ───────────────────────── diagnostics (Settings → About & help) ─────────────────────────

/**
 * What "Copy diagnostics" reports, built in main from non-secret fields only. Counts,
 * versions and provider ids — NEVER keys, passwords, udids, proxy credentials, account
 * labels (they can be emails), exit IPs or server IPs/hostnames. Keep it that way: the
 * text is meant to be pasted into a public GitHub issue.
 */
export interface Diagnostics {
  appVersion: string;
  os: { platform: string; release: string; arch: string };
  versions: { electron: string; chrome: string; node: string };
  /** The bundled sing-box version, or null when the engine check failed at startup. */
  singBox: string | null;
  providers: Array<{
    id: ProviderId;
    accounts: number;
    ports: number;
    /** Port count per `PortState['kind']`; kinds with no ports are omitted. */
    portStates: Partial<Record<PortState['kind'], number>>;
  }>;
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
  /** `credentials`: the username/password an `.ovpn` with `auth-user-pass` signs in with.
   * Without them such a file answers `file.check.needsCredentials`. */
  importConfigFile(
    name: string,
    content: string,
    country?: string,
    credentials?: { username: string; password: string },
  ): Promise<CheckResult & { account?: Account }>;
  /** Locations with `freeServers` filled in (spec §6.8). */
  listTargets(providerId?: ProviderId): Promise<Target[]>;

  // ports (keys are port keys `<locationKey>#<n>` unless stated otherwise)
  listPorts(): Promise<PortRow[]>;
  /** Adds up to `count` ports to a location, each on a different free usable server, and
   * starts them. `added` may be shorter than `count`; `noteKey` then says why
   * ('no-free-server' | 'limit-reached'). */
  addPorts(locationKey: string, count: number): Promise<{ added: PortRow[]; noteKey?: string }>;
  /** The location's server pool with health and which port holds each server. Health
   * is for `portKey`'s account when given (the Change-IP menu of that port), else merged
   * over the accounts the location's ports use. */
  listServers(locationKey: string, portKey?: string): Promise<ServerInfo[]>;
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

  // support
  /** A redacted environment summary for bug reports (see `Diagnostics`). */
  getDiagnostics(): Promise<Diagnostics>;

  // push events (return an unsubscribe fn)
  onPortsChanged(cb: (rows: PortRow[]) => void): () => void;
  onHostVpnChanged(cb: (active: boolean) => void): () => void;
  /** A server health mark changed (refused, dead, confirmed online, or a hostname
   * resolved onto a marked machine): the locations' `freeServers`/`notInPlan` from
   * `listTargets` may be out of date. Carries nothing; re-read what you show. */
  onTargetsChanged(cb: () => void): () => void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}

/** Channel names used by preload ↔ main. Preload exposes exactly these, nothing else. */
export const IPC = {
  invoke: [
    'listProviders', 'addAccount', 'removeAccount', 'connectHma', 'enableHmaSupport', 'importConfigFile', 'listTargets',
    'listPorts', 'addPorts', 'listServers', 'startPorts', 'stopPorts', 'removePorts', 'rotatePort', 'setAutoRotate', 'setLimit',
    'testPort', 'getLogs', 'exportPorts', 'getSettings', 'setSettings', 'getHostVpnActive', 'getAppStatus',
    'getUpdateStatus', 'checkForUpdate', 'downloadAndInstallUpdate', 'getDiagnostics',
  ] as const,
  events: {
    portsChanged: 'pf:portsChanged',
    hostVpnChanged: 'pf:hostVpnChanged',
    targetsChanged: 'pf:targetsChanged',
    updateStatus: 'pf:updateStatus',
  } as const,
} as const;

declare global {
  interface Window {
    proxyFarm: ProxyFarmApi;
  }
}
