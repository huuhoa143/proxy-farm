import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

/**
 * "Other VPN on this computer" detection (spec §4.3/§4.4.3). Info only: Proxy Farm
 * keeps working regardless, this just drives a small grey note in the UI.
 */
export interface HostVpnDetector {
  isHostVpnActive(): Promise<boolean>;
}

export interface HostVpnMonitor extends HostVpnDetector {
  /** Starts polling every `pollMs` (default 10s); emits via `onChange` on transitions. */
  start(): void;
  stop(): void;
  onChange(cb: (active: boolean) => void): () => void;
}

export interface CreateHostVpnMonitorOptions {
  platform?: NodeJS.Platform;
  /** Injectable for tests: runs `route -n get default` and returns its stdout. */
  runDefaultRouteCheck?: () => Promise<string>;
  /** Injectable for tests (win32): `route print -4` output. */
  readWindowsRoutes?: () => Promise<string>;
  /** Injectable for tests (win32): the adapters that are up, IPv4 address → name (alias). */
  readWindowsAdapters?: () => Record<string, string>;
  /** Injectable for tests (win32): every adapter's description by name (alias). */
  describeWindowsAdapters?: () => Promise<Record<string, string>>;
  pollMs?: number;
}

/** A tunnel interface name that macOS VPN clients (HMA's ipsec0, WireGuard's utunN,
 * OpenVPN's tunN, PPP-based clients' pppN, …) use for the default route when they take
 * it over (spec §4.3). */
const TUNNEL_INTERFACE_RE = /^(ipsec|utun|tun|ppp)\d*$/i;

/**
 * `route -n get 1.1.1.1` (a public literal, not the string "default") instead of
 * `route -n get default`: some VPN clients never touch the literal default route at
 * all, instead installing a 0.0.0.0/1 + 128.0.0.0/1 "split" pair that only outranks the
 * real default for routes that actually fall under them — `get default` would still
 * report the original interface, while `get 1.1.1.1` follows the more specific split
 * route and reveals the tunnel.
 */
function defaultRunner(): Promise<string> {
  return new Promise((resolve, reject) => {
    // A `timeout` guards against a hung/zombie `route` child (seen in sandboxed CI and
    // some VPN clients that intercept routing-socket queries) wedging the poll loop
    // forever — `execFile` kills the child and errors out once the limit is hit
    // (reviewer item 10).
    execFile('/sbin/route', ['-n', 'get', '1.1.1.1'], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Exported for direct unit testing against fixed sample output. */
export function isDefaultRouteViaTunnel(routeGetDefaultOutput: string): boolean {
  const match = routeGetDefaultOutput.match(/^\s*interface:\s*(\S+)/m);
  if (!match) return false;
  return TUNNEL_INTERFACE_RE.test(match[1]);
}

/** What the win32 check reads. */
export interface WindowsRouteSnapshot {
  /** `route print -4` output. */
  routes: string;
  /** IPv4 address → label of each adapter that is up (libuv's `os.networkInterfaces()`
   * lists only those): its name plus its description, see `labelAdapters`. */
  adapters: Record<string, string>;
}

/** Adapter names and descriptions Windows VPN clients use: Wintun (HMA, WireGuard-based
 * apps), WireGuard for Windows ("WireGuard Tunnel"), TAP and OpenVPN DCO adapters, the
 * vendors' own names, and Windows' own VPN miniports. Not PPP or "WAN Miniport (PPPoE)":
 * PPPoE broadband dial-up (common with Vietnamese ISPs) is not a VPN. */
const WINDOWS_VPN_ADAPTER_RE =
  /vpn|wintun|wireguard|\btap\b|tap-windows|\btun\b|openvpn|nordlynx|proton|surfshark|mullvad|windscribe|warp|wan miniport \((?:ikev2|sstp|l2tp|pptp)\)/i;

const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
/** An "Active Routes" row: destination, netmask, gateway (an address or a localised
 * "On-link"), interface address, metric. Persistent-route rows have no interface column. */
const ROUTE_ROW_RE = new RegExp(String.raw`^\s*(${IPV4})\s+(${IPV4})\s+\S.*?\s(${IPV4})\s+(\d+)\s*$`);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function maskLength(mask: number): number {
  let bits = 0;
  for (let m = mask; m !== 0; m = (m << 1) >>> 0) bits++;
  return bits;
}

/** The adapters that are up, by IPv4 address. */
export function upAdaptersByAddress(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4') out[a.address] = name;
  }
  return out;
}

/**
 * IPv4 address → "<name> <description>". The name alone is not enough: WireGuard for Windows
 * names its adapter after the tunnel ("office"), and a TAP adapter is usually "Ethernet N";
 * their descriptions ("WireGuard Tunnel", "TAP-Windows Adapter V9") give them away.
 */
export function labelAdapters(up: Record<string, string>, descriptions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ip, name] of Object.entries(up)) out[ip] = descriptions[name] ? `${name} ${descriptions[name]}` : name;
  return out;
}

/** Every adapter's description by name, from `Get-NetAdapter` (PowerShell: ~1 s, so the
 * monitor asks only when the set of adapters that are up changes). */
function defaultDescribeWindowsAdapters(): Promise<Record<string, string>> {
  const script =
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    'ConvertTo-Json -Compress -InputObject @(Get-NetAdapter -IncludeHidden | ForEach-Object { [pscustomobject]@{ n = [string]$_.Name; d = [string]$_.InterfaceDescription } })';
  return new Promise((resolve, reject) => {
    execFile(
      path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const out: Record<string, string> = {};
          for (const a of JSON.parse(stdout) as Array<{ n: string; d: string }>) out[a.n] = a.d;
          resolve(out);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/** Whether any up adapter looks like a VPN client's: without one the route check below
 * cannot answer true, so the caller need not read the route table at all. */
export function hasVpnNamedAdapter(adapters: Record<string, string>): boolean {
  return Object.values(adapters).some((name) => WINDOWS_VPN_ADAPTER_RE.test(name));
}

/**
 * Whether Windows routes 1.1.1.1 through a VPN adapter, from `route print -4` (spec §4.3).
 * Mirrors the OS choice: the longest prefix containing the address wins, then the lowest
 * metric (`route print` shows route + interface metric already summed). Like the macOS
 * check it follows a 0.0.0.0/1 + 128.0.0.0/1 split pair, which outranks the default route.
 * Each row names its adapter by address, mapped to the adapter's name through
 * `adapters`; no localised text (headers, "On-link", interface states) is relied on.
 */
export function isWindowsRouteViaVpn(snapshot: WindowsRouteSnapshot, address = '1.1.1.1'): boolean {
  const target = ipv4ToInt(address);
  let best: { prefix: number; metric: number; name: string } | undefined;
  for (const line of snapshot.routes.split(/\r?\n/)) {
    const m = line.match(ROUTE_ROW_RE);
    if (!m) continue;
    const mask = ipv4ToInt(m[2]) >>> 0;
    if (((ipv4ToInt(m[1]) & mask) >>> 0) !== ((target & mask) >>> 0)) continue;
    // Active routes of an adapter that is down are not listed; this also skips an address
    // no adapter that is up carries.
    const name = snapshot.adapters[m[3]];
    if (name === undefined) continue;
    const prefix = maskLength(mask);
    const metric = Number(m[4]);
    if (!best || prefix > best.prefix || (prefix === best.prefix && metric < best.metric)) best = { prefix, metric, name };
  }
  return best !== undefined && WINDOWS_VPN_ADAPTER_RE.test(best.name);
}

function defaultReadWindowsRoutes(): Promise<string> {
  return new Promise((resolve, reject) => {
    // By absolute path: never whatever an inherited PATH finds first.
    execFile(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'route.exe'), ['print', '-4'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function createHostVpnMonitor(options: CreateHostVpnMonitorOptions = {}): HostVpnMonitor {
  const platform = options.platform ?? process.platform;
  const runDefaultRouteCheck = options.runDefaultRouteCheck ?? defaultRunner;
  const readWindowsRoutes = options.readWindowsRoutes ?? defaultReadWindowsRoutes;
  const readWindowsAdapters = options.readWindowsAdapters ?? upAdaptersByAddress;
  const describeWindowsAdapters = options.describeWindowsAdapters ?? defaultDescribeWindowsAdapters;
  const pollMs = options.pollMs ?? 10_000;
  /** Descriptions, refreshed only when the set of adapters that are up changes. */
  let described: { key: string; byName: Record<string, string> } | undefined;

  async function windowsAdapters(): Promise<Record<string, string>> {
    const up = readWindowsAdapters();
    const key = [...new Set(Object.values(up))].sort().join('\n');
    if (described?.key !== key) {
      // Without descriptions, names still work: a failure is cached like a result, so a
      // broken PowerShell is not retried every poll, only on the next adapter change.
      described = { key, byName: await describeWindowsAdapters().catch(() => ({})) };
    }
    return labelAdapters(up, described.byName);
  }

  const listeners = new Set<(active: boolean) => void>();
  let lastKnown: boolean | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;

  async function isHostVpnActive(): Promise<boolean> {
    if (platform === 'win32') {
      try {
        // Polled every 10 s: spawn nothing unless an adapter that is up could be a VPN.
        const adapters = await windowsAdapters();
        if (!hasVpnNamedAdapter(adapters)) return false;
        return isWindowsRouteViaVpn({ routes: await readWindowsRoutes(), adapters });
      } catch {
        return false;
      }
    }
    if (platform !== 'darwin') return false;
    try {
      const output = await runDefaultRouteCheck();
      return isDefaultRouteViaTunnel(output);
    } catch {
      return false;
    }
  }

  async function poll(): Promise<void> {
    // A slow route check (or a slow interval) must never overlap with itself: skip this
    // tick rather than pile up concurrent `route` child processes.
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const active = await isHostVpnActive();
      if (active !== lastKnown) {
        lastKnown = active;
        for (const cb of listeners) cb(active);
      }
    } finally {
      pollInFlight = false;
    }
  }

  return {
    isHostVpnActive,
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
