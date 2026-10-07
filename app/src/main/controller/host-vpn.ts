import { execFile } from 'node:child_process';

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
  pollMs?: number;
}

/** A tunnel interface name that macOS VPN clients (HMA's ipsec0, WireGuard's utunN, …)
 * use for the default route when they take it over (spec §4.3). */
const TUNNEL_INTERFACE_RE = /^(ipsec|utun)\d*$/i;

function defaultRunner(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('route', ['-n', 'get', 'default'], (err, stdout) => {
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

export function createHostVpnMonitor(options: CreateHostVpnMonitorOptions = {}): HostVpnMonitor {
  const platform = options.platform ?? process.platform;
  const runDefaultRouteCheck = options.runDefaultRouteCheck ?? defaultRunner;
  const pollMs = options.pollMs ?? 10_000;

  const listeners = new Set<(active: boolean) => void>();
  let lastKnown: boolean | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function isHostVpnActive(): Promise<boolean> {
    if (platform === 'win32') return false; // §12: unverified, TODO for the Windows track
    if (platform !== 'darwin') return false;
    try {
      const output = await runDefaultRouteCheck();
      return isDefaultRouteViaTunnel(output);
    } catch {
      return false;
    }
  }

  async function poll(): Promise<void> {
    const active = await isHostVpnActive();
    if (active !== lastKnown) {
      lastKnown = active;
      for (const cb of listeners) cb(active);
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
