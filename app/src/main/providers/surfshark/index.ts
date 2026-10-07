/**
 * Surfshark provider — WireGuard, keyed on the account's private key
 * (spec §5.3).
 *
 * `bind()` must be deterministic even for a persisted port rebound after an
 * app restart (i.e. with no prior `targets()` call on this instance), so it
 * never relies on in-memory state warmed by `targets()`. Instead it reads
 * the peer's public key straight off the on-disk cluster cache
 * (`readClustersCacheSync`, spec's 12h-cached cluster list) by target key —
 * a synchronous, no-network read, the same precedent as the hma/zoogvpn CA
 * files being read with `readFileSync`. If the cache has no matching
 * cluster (never fetched, or the location vanished from a refresh), it
 * throws a clear, catchable error rather than binding to nothing.
 *
 * The cache path is NOT defaulted to `process.cwd()` — the factory requires
 * it, so the controller must pass something durable, e.g.
 * `path.join(app.getPath('userData'), 'cache', 'surfshark-clusters.json')`.
 *
 * Re-resolving the host and switching the peer IP when a probe fails
 * (spec §5.3, "IPs went stale within minutes") is a health-module concern:
 * `bind()` just takes whatever `serverIp` it's given.
 */
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { getClusters, readClustersCacheSync, type SurfsharkCluster } from './clusters';

const WG_PORT = 51820;
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export interface SurfsharkProviderDeps {
  /** Required: where the 12h cluster cache lives. No cwd-based default. */
  cachePath: string;
  loadClusters?: () => Promise<SurfsharkCluster[]>;
}

function targetKeyFor(cluster: SurfsharkCluster): string {
  // connectionName looks like "jp-tok.prod.surfshark.com" — the first
  // label is Surfshark's own short location code, stable across refreshes.
  const shortCode = cluster.connectionName.split('.')[0];
  return `surfshark:${shortCode}`;
}

export function createSurfsharkProvider(deps: SurfsharkProviderDeps): Provider {
  const cachePath = deps.cachePath;
  const loadClusters = deps.loadClusters ?? (() => getClusters({ cachePath }));

  return {
    id: 'surfshark',

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const privateKey = input.privateKey ?? '';
      if (!WG_KEY_RE.test(privateKey)) {
        return { ok: false, reasonKey: 'surfshark.check.invalidKey' };
      }
      return {
        ok: true,
        label: `key …${privateKey.slice(-6)}`,
        secret: { kind: 'wgkey', privateKey },
      };
    },

    async targets(_account: Account): Promise<Target[]> {
      const clusters = await loadClusters();
      return clusters.map((cluster) => ({
        key: targetKeyFor(cluster),
        providerId: 'surfshark',
        country: cluster.countryCode,
        city: cluster.location,
        label: `${cluster.country} — ${cluster.location}`,
        servers: [cluster.connectionName],
      }));
    },

    bind(target: Target, serverIp: string, _account: Account, secret: AccountSecret) {
      if (secret.kind !== 'wgkey') {
        throw new Error('surfshark: bind() requires a wgkey secret');
      }
      const clusters = readClustersCacheSync(cachePath);
      const cluster = clusters?.find((c) => targetKeyFor(c) === target.key);
      if (!cluster) {
        throw new Error(
          `surfshark: no cached cluster for target "${target.key}" — refresh the cluster cache (call targets()) first`,
        );
      }
      return {
        type: 'wireguard' as const,
        address: ['10.14.0.2/16'],
        private_key: secret.privateKey,
        mtu: 1280,
        peers: [
          {
            address: serverIp,
            port: WG_PORT,
            public_key: cluster.pubKey,
            allowed_ips: ['0.0.0.0/0'],
            persistent_keepalive_interval: 25,
          },
        ],
      };
    },
  };
}
