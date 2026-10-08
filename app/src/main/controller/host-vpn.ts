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
  /** Injectable for tests (win32): the IPv4 route table, interfaces and up adapters. */
  readWindowsRoutes?: () => Promise<WindowsRouteSnapshot>;
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

/** What the win32 check reads: `netsh interface ipv4 show route` / `show interfaces`
 * output and the names of the adapters that are up. */
export interface WindowsRouteSnapshot {
  routes: string;
  interfaces: string;
  /** Adapter names (aliases) that are up: libuv's `os.networkInterfaces()` lists only those. */
  upNames: string[];
}

/** Adapter names Windows VPN clients use: Wintun (HMA, WireGuard-based apps), TAP and
 * OpenVPN DCO adapters, and the vendors' own names. */
const WINDOWS_VPN_ADAPTER_RE =
  /vpn|wintun|wireguard|\btap\b|tap-windows|\btun\b|openvpn|nordlynx|proton|surfshark|mullvad|windscribe|warp|ppp|wan miniport/i;

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/**
 * Whether Windows routes 1.1.1.1 through a VPN adapter, from `netsh` output (spec §4.3).
 * Mirrors the OS choice: among the routes of adapters that are up, the longest prefix
 * containing the address wins, then the lowest route + interface metric. Like the macOS
 * check it follows a 0.0.0.0/1 + 128.0.0.0/1 split pair, which outranks the default
 * route. The column layout is parsed structurally, so localised headers don't matter.
 */
export function isWindowsRouteViaVpn(snapshot: WindowsRouteSnapshot, address = '1.1.1.1'): boolean {
  const up = new Set(snapshot.upNames);
  const ifaces = new Map<number, { metric: number; name: string }>();
  for (const line of snapshot.interfaces.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+\d+\s+\S+\s+(.+?)\s*$/);
    if (m) ifaces.set(Number(m[1]), { metric: Number(m[2]), name: m[3] });
  }
  const target = ipv4ToInt(address);
  let best: { prefix: number; metric: number; name: string } | undefined;
  for (const line of snapshot.routes.split(/\r?\n/)) {
    const m = line.match(/\s(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const prefix = Number(m[3]);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((ipv4ToInt(m[2]) & mask) >>> 0) !== ((target & mask) >>> 0)) continue;
    const iface = ifaces.get(Number(m[4]));
    if (!iface || !up.has(iface.name)) continue;
    const metric = Number(m[1]) + iface.metric;
    if (!best || prefix > best.prefix || (prefix === best.prefix && metric < best.metric)) best = { prefix, metric, name: iface.name };
  }
  return best !== undefined && WINDOWS_VPN_ADAPTER_RE.test(best.name);
}

function runNetsh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // By absolute path: never whatever an inherited PATH finds first.
    execFile(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netsh.exe'), args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function defaultReadWindowsRoutes(): Promise<WindowsRouteSnapshot> {
  const [routes, interfaces] = await Promise.all([
    runNetsh(['interface', 'ipv4', 'show', 'route']),
    runNetsh(['interface', 'ipv4', 'show', 'interfaces']),
  ]);
  return { routes, interfaces, upNames: Object.keys(networkInterfaces()) };
}

export function createHostVpnMonitor(options: CreateHostVpnMonitorOptions = {}): HostVpnMonitor {
  const platform = options.platform ?? process.platform;
  const runDefaultRouteCheck = options.runDefaultRouteCheck ?? defaultRunner;
  const readWindowsRoutes = options.readWindowsRoutes ?? defaultReadWindowsRoutes;
  const pollMs = options.pollMs ?? 10_000;

  const listeners = new Set<(active: boolean) => void>();
  let lastKnown: boolean | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;

  async function isHostVpnActive(): Promise<boolean> {
    if (platform === 'win32') {
      try {
        return isWindowsRouteViaVpn(await readWindowsRoutes());
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
