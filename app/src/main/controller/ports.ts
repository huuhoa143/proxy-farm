/**
 * Thin internal interfaces the controller consumes from the engine/ and providers/
 * modules, which are built in parallel in sibling worktrees and are NOT importable
 * here. The integrator binds the real implementations at merge time; unit tests in
 * this worktree use fakes of these same interfaces.
 */
import type { DelayResult, EndpointSpec, ExitIpResult, PortState, Provider, ProviderId, RenderInput } from '../../shared/contracts';

/**
 * One sing-box process per port (spec §6.1/§6.3), fully self-contained: `start` takes
 * the raw `RenderInput` (the real adapter renders it, allocates+owns its own clash
 * port/secret, enforces §6.1 invariants, wires `onLog`/`onExit` into a `PortHealth`, and
 * polls `/delay`). `PortHealth` OWNS the port's `PortState` — the controller only
 * observes it via `onStateChange` and persists it; it never sets `connecting` /
 * `online` / `retrying` itself (reviewer item 6).
 */
export interface Engine {
  /** Spawn (or respawn) the process for `key` with this render input. */
  start(key: string, input: RenderInput): Promise<void>;
  /** Stop and wait for exit (SIGINT on macOS, hard terminate on Windows — §6.3). */
  stop(key: string): Promise<void>;
  /** clash_api `/proxies/<tag>/delay` health probe (§6.4). */
  probe(key: string): Promise<DelayResult>;
  /** The redacted log ring for this port's current (or last) process. */
  getLogs(key: string): string[];
  /** Subscribes to every `PortHealth` state transition for every port. */
  onStateChange(cb: (key: string, state: PortState) => void): () => void;
  /**
   * Subscribes to a port's back-off timer elapsing (a retry is due). The controller
   * handles it by re-resolving the host + re-selecting a server (skipping IPs recently
   * marked bad) and respawning through its own start path, so a dead/stale IP is not
   * looped on forever (spec §6.4 bad-IP failover). OPTIONAL: an engine without this —
   * or with no listener registered — falls back to respawning its own last rendered
   * config in place (the pre-failover behaviour).
   */
  onRetryDue?(cb: (key: string) => void): () => void;
}

/** Thrown by the real `Engine.start` when the proxy port itself (not an auxiliary one)
 * is already bound by something else — the one bind failure §6.2 says is terminal
 * rather than retried with a new port: `failed('port-in-use')`, "Move to another port". */
export class PortInUseError extends Error {
  constructor(public readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

/** Looks up the provider plugin for one provider id (§5). */
export interface ProviderRegistry {
  get(providerId: ProviderId): Provider | undefined;
}

export interface ProxyAuth {
  username: string;
  password: string;
}

/** https IP-echo probe through a port's local proxy, with provider fallback chain
 * already applied by the real implementation (§6.4: ipify -> ifconfig.co -> ipinfo).
 * `auth` is required whenever the proxy enforces credentials (reviewer item 3: a probe
 * with no credentials against an authenticated inbound would just fail/hang). */
export interface ExitIpProber {
  probe(proxyPort: number, auth?: ProxyAuth): Promise<ExitIpResult>;
}

export interface AllocatePortOptions {
  /** Try this port first. */
  preferred?: number;
  /** Ports to treat as occupied even if nothing is actually listening — e.g. every
   * `proxyPort` already assigned to another row (reviewer item 5: without this, two
   * concurrent/sequential allocations can both land on the same "free" port). */
  taken?: Set<number>;
  /** Where to start scanning if `preferred` is unavailable (or absent). */
  base?: number;
}

/** Test-binds a candidate port on both 127.0.0.1 and 0.0.0.0 before handing it out
 * (§6.2's wildcard-listener trap). */
export interface PortAllocator {
  /** Returns a free, untaken proxy port, trying `preferred` first when given. */
  allocate(opts?: AllocatePortOptions): Promise<number>;
  /** Returns a free auxiliary port (e.g. clash_api) in some private range. */
  allocateAux(opts?: { taken?: Set<number> }): Promise<number>;
  release(port: number): void;
}

/** Reconstructs the concrete endpoint for one (target, server, account) triple: looks
 * up the account's decrypted secret and calls the provider's pure `bind`. Kept as its
 * own port so port-manager does not need to know the secrets-store JSON convention. */
export interface EndpointBinder {
  bind(providerId: ProviderId, targetKey: string, serverIp: string, accountId: string): Promise<EndpointSpec | undefined>;
}
