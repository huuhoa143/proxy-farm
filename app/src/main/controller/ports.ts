/**
 * Thin internal interfaces the controller consumes from the engine/ and providers/
 * modules, which are built in parallel in sibling worktrees and are NOT importable
 * here. The integrator binds the real implementations at merge time; unit tests in
 * this worktree use fakes of these same interfaces.
 */
import type { DelayResult, EndpointSpec, ExitIpResult, Provider, ProviderId, RenderInput } from '../../shared/contracts';

/** One sing-box process per port (spec §6.1/§6.3). Config is handed in as a string,
 * never a path — the real engine renders it via `renderConfig` and pipes it to the
 * child's stdin. */
export interface Engine {
  /** Pure: endpoint + settings -> the sing-box JSON config string (§6.1 invariants). */
  renderConfig(input: RenderInput): string;
  /** Spawn (or respawn) the process for `key` with this rendered config. */
  start(key: string, config: string): Promise<void>;
  /** Stop and wait for exit (SIGINT on macOS, hard terminate on Windows — §6.3). */
  stop(key: string): Promise<void>;
  /** clash_api `/proxies/<tag>/delay` health probe (§6.4). */
  probe(key: string): Promise<DelayResult>;
}

/** Looks up the provider plugin for one provider id (§5). */
export interface ProviderRegistry {
  get(providerId: ProviderId): Provider | undefined;
}

/** https IP-echo probe through a port's local proxy, with provider fallback chain
 * already applied by the real implementation (§6.4: ipify -> ifconfig.co -> ipinfo). */
export interface ExitIpProber {
  probe(proxyPort: number): Promise<ExitIpResult>;
}

/** Test-binds a candidate port on both 127.0.0.1 and 0.0.0.0 before handing it out
 * (§6.2's wildcard-listener trap). */
export interface PortAllocator {
  /** Returns a free proxy port, trying `preferred` first when given. */
  allocate(preferred?: number): Promise<number>;
  /** Returns a free auxiliary port (e.g. clash_api) in some private range. */
  allocateAux(): Promise<number>;
  release(port: number): void;
}

/** Reconstructs the concrete endpoint for one (target, server, account) triple: looks
 * up the account's decrypted secret and calls the provider's pure `bind`. Kept as its
 * own port so port-manager does not need to know the secrets-store JSON convention. */
export interface EndpointBinder {
  bind(providerId: ProviderId, targetKey: string, serverIp: string, accountId: string): Promise<EndpointSpec | undefined>;
}
