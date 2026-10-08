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
 *
 * Each Surfshark key pair comes with its own interface address (the `Address` line of
 * the config downloaded next to the key: `10.14.0.2/16` for some keys, `10.64.x.y/16`
 * for others). The account keeps it in `meta.address` (not a secret); `check()` takes it
 * from an optional `address` field or from a pasted/imported `.conf`.
 */
import path from 'node:path';
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { getClusters, readClustersCacheSync, type SurfsharkCluster } from './clusters';
import { createSurfsharkPools, type PoolNet, type SurfsharkPools } from './pool';

const WG_PORT = 51820;
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** The interface address of most Surfshark keys; used when the user gives none. */
export const DEFAULT_SURFSHARK_ADDRESS = '10.14.0.2/16';

/** An IPv4 CIDR such as `10.14.0.2/16`, normalised (no spaces, no leading zeros), or
 * undefined if `raw` is not one. */
export function parseIpv4Cidr(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  return `${octets.join('.')}/${prefix}`;
}

/**
 * The two fields this provider needs from a WireGuard `.conf` as Surfshark's dashboard
 * downloads it: `[Interface] PrivateKey` and the first IPv4 of `[Interface] Address`
 * (an address without a prefix length is a single host, /32). Everything else (DNS,
 * the peer, its endpoint) is ignored: the peer comes from the cluster list.
 */
export function parseSurfsharkConf(content: string): { privateKey?: string; address?: string } {
  let section = '';
  const out: { privateKey?: string; address?: string } = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, '').trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const kv = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
    if (!kv || section !== 'interface') continue;
    const key = kv[1].toLowerCase();
    if (key === 'privatekey' && out.privateKey === undefined) out.privateKey = kv[2].trim();
    if (key === 'address' && out.address === undefined) {
      for (const part of kv[2].split(',')) {
        const candidate = part.trim().includes('/') ? part.trim() : `${part.trim()}/32`;
        const cidr = parseIpv4Cidr(candidate);
        if (cidr) {
          out.address = cidr;
          break;
        }
      }
    }
  }
  return out;
}

/** Looks like a whole config rather than a bare key. */
function looksLikeConf(text: string): boolean {
  return /\[\s*interface\s*\]/i.test(text);
}

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

    /**
     * Input: `privateKey` (the bare key, or a whole pasted `.conf`) or `config` (an
     * imported `.conf`), plus an optional `address` (IPv4 CIDR). A config's own Address
     * wins over the field; with neither, the address is `DEFAULT_SURFSHARK_ADDRESS`.
     */
    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const pasted = (input.config ?? '').trim() || (input.privateKey ?? '').trim();
      let privateKey = pasted;
      let address: string | undefined;
      if (looksLikeConf(pasted)) {
        const conf = parseSurfsharkConf(pasted);
        if (!conf.privateKey) return { ok: false, reasonKey: 'surfshark.check.invalidConfig' };
        privateKey = conf.privateKey;
        address = conf.address;
      }
      if (!WG_KEY_RE.test(privateKey)) {
        return { ok: false, reasonKey: 'surfshark.check.invalidKey' };
      }
      if (address === undefined) {
        const typed = (input.address ?? '').trim();
        if (typed) {
          address = parseIpv4Cidr(typed);
          if (!address) return { ok: false, reasonKey: 'surfshark.check.invalidAddress' };
        }
      }
      return {
        ok: true,
        label: `key …${privateKey.slice(-6)}`,
        secret: { kind: 'wgkey', privateKey },
        meta: { address: address ?? DEFAULT_SURFSHARK_ADDRESS },
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
          poolHostnames: true,
        };
      });
    },

    bind(target: Target, serverIp: string, account: Account, secret: AccountSecret) {
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
        // Accounts added before the address was stored have none: the old fixed default.
        address: [parseIpv4Cidr(account.meta.address ?? '') ?? DEFAULT_SURFSHARK_ADDRESS],
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
