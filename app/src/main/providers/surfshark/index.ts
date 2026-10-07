/**
 * Surfshark provider — WireGuard, keyed on the account's private key
 * (spec §5.3).
 *
 * `targets()` resolves the current (≤12h cached) cluster list and also
 * populates an in-memory `key → cluster` cache so `bind()` can find the
 * peer's public key for a given target without re-fetching or threading
 * extra fields through the `Target` shape from contracts.ts. The controller
 * always calls `listTargets()` (→ `targets()`) before `startPorts()` (→
 * `bind()`), so the cache is warm by the time `bind()` runs; a target whose
 * cluster was never resolved throws a clear error rather than silently
 * binding to nothing.
 *
 * Re-resolving the host and switching the peer IP when a probe fails
 * (spec §5.3, "IPs went stale within minutes") is a health-module concern:
 * `bind()` just takes whatever `serverIp` it's given.
 */
import path from 'node:path';
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { getClusters, type SurfsharkCluster } from './clusters';

const WG_PORT = 51820;
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const DEFAULT_CACHE_PATH = path.join(process.cwd(), '.cache', 'proxy-farm', 'surfshark-clusters.json');

export interface SurfsharkProviderDeps {
  loadClusters?: () => Promise<SurfsharkCluster[]>;
}

export function createSurfsharkProvider(deps: SurfsharkProviderDeps = {}): Provider {
  const loadClusters = deps.loadClusters ?? (() => getClusters({ cachePath: DEFAULT_CACHE_PATH }));
  const clusterByKey = new Map<string, SurfsharkCluster>();

  function targetKeyFor(cluster: SurfsharkCluster): string {
    // connectionName looks like "jp-tok.prod.surfshark.com" — the first
    // label is Surfshark's own short location code, stable across refreshes.
    const shortCode = cluster.connectionName.split('.')[0];
    return `surfshark:${shortCode}`;
  }

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
      const out: Target[] = [];
      for (const cluster of clusters) {
        const key = targetKeyFor(cluster);
        clusterByKey.set(key, cluster);
        out.push({
          key,
          providerId: 'surfshark',
          country: cluster.countryCode,
          city: cluster.location,
          label: `${cluster.country} — ${cluster.location}`,
          servers: [cluster.connectionName],
        });
      }
      return out;
    },

    bind(target: Target, serverIp: string, _account: Account, secret: AccountSecret) {
      if (secret.kind !== 'wgkey') {
        throw new Error('surfshark: bind() requires a wgkey secret');
      }
      const cluster = clusterByKey.get(target.key);
      if (!cluster) {
        throw new Error(
          `surfshark: unknown target "${target.key}" — call targets() to (re)warm the cluster cache before bind()`,
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

export const surfsharkProvider = createSurfsharkProvider();
