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
 * A target's servers are its cluster's pool IPs (spec §5.3 rev 3, pool.ts),
 * persisted next to the cluster cache. Each pool IP is one fixed exit and
 * the cluster pubKey works for all of them, so `bind()` just takes whatever
 * `serverIp` it's given; failing over between pool servers is the
 * controller's job (§6.8). Until a cluster's first DNS sample lands (or if
 * discovery keeps failing) its only server is the cluster hostname, which
 * the controller resolves to whichever pool IP DNS hands out.
 */
import path from 'node:path';
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { getClusters, readClustersCacheSync, type SurfsharkCluster } from './clusters';
import { createSurfsharkPools, type PoolNet, type SurfsharkPools } from './pool';

const WG_PORT = 51820;
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export interface SurfsharkProviderDeps {
  /** Required: where the 12h cluster cache lives. No cwd-based default. */
  cachePath: string;
  loadClusters?: () => Promise<SurfsharkCluster[]>;
  /** Where the server pools live; defaults to `surfshark-pools.json` beside `cachePath`. */
  poolPath?: string;
  /** DNS access for pool discovery (tests inject a fake). */
  poolNet?: PoolNet;
  /** A ready-made pool store; overrides `poolPath` / `poolNet`. */
  pools?: SurfsharkPools;
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
  const pools =
    deps.pools ??
    createSurfsharkPools({
      poolPath: deps.poolPath ?? path.join(path.dirname(cachePath), 'surfshark-pools.json'),
      net: deps.poolNet,
    });

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
      await pools.ensure(clusters.map((c) => c.connectionName));
      return clusters.map((cluster) => {
        const pool = pools.servers(cluster.connectionName);
        return {
          key: targetKeyFor(cluster),
          providerId: 'surfshark',
          country: cluster.countryCode,
          city: cluster.location,
          label: `${cluster.country} — ${cluster.location}`,
          servers: pool.length > 0 ? pool : [cluster.connectionName],
        };
      });
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
