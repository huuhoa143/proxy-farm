/**
 * NordVPN provider — NordLynx (WireGuard) keyed on the account's NordLynx private key
 * (spec §5.5).
 *
 * Adding an account takes either a Nord Account access token or the NordLynx private
 * key itself. A token is exchanged for the key once, in `resolveInput` (the only
 * network step; `check` stays synchronous and offline), and then forgotten: only the
 * key is stored, as a `wgkey` secret.
 *
 * Locations come from the public server list (servers.ts), one per (country, city);
 * a location's servers are its servers' IPs, least loaded first. Each server has its
 * own WireGuard public key, kept in the on-disk cache, so `bind()` reads it from there
 * synchronously and deterministically, like Surfshark's cluster cache.
 *
 * A server's exit IP is NOT the server IP (vn52 at .1 exited from .22, and from .15 in a
 * later session) but kept across reconnects within a session and differs between
 * servers ✅ 2026-10-09, so ports pin servers as usual and the observed exit IP is what
 * the UI shows and the duplicate-exit check compares.
 */
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { ACCESS_TOKEN_RE, exchangeAccessToken, WG_KEY_RE } from './credentials';
import { getServers, readServersCacheSync, type FetchLike, type NordLocation } from './servers';
import { wgKeyLabel } from '../wg-key';

const WG_PORT = 51820;
/** NordLynx's interface address: the same for every key ✅ 2026-10-09. */
export const NORDLYNX_ADDRESS = '10.5.0.2/32';

export interface NordvpnProviderDeps {
  /** Required: where the 12 h server-list cache lives (beside Surfshark's). */
  cachePath: string;
  /** Network access (tests inject a fake). */
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** The single input field accepts either form; older callers may name it. */
function credentialOf(input: Record<string, string>): string {
  return (input.credential ?? input.token ?? input.privateKey ?? '').trim();
}

function toTarget(loc: NordLocation): Target {
  return {
    key: loc.key,
    providerId: 'nordvpn',
    country: loc.country,
    city: loc.city,
    label: `${loc.countryName} — ${loc.city}`,
    servers: loc.servers.map((s) => s.ip),
  };
}

export function createNordvpnProvider(deps: NordvpnProviderDeps): Provider {
  const { cachePath, fetchImpl, now } = deps;
  // Several accounts list targets at once: share one fetch rather than racing.
  let inflight: Promise<NordLocation[]> | undefined;
  const loadLocations = () => {
    inflight ??= getServers({ cachePath, fetchImpl, now }).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return {
    id: 'nordvpn',

    async resolveInput(input) {
      const credential = credentialOf(input);
      if (!ACCESS_TOKEN_RE.test(credential)) return { input };
      const result = await exchangeAccessToken(credential, fetchImpl);
      if (!result.ok) return { reasonKey: result.reasonKey };
      return { input: { privateKey: result.privateKey } };
    },

    /**
     * Input: `credential` (or `privateKey`) = the NordLynx private key. An access token
     * here means `resolveInput` was skipped, so it could not be exchanged: refused, never
     * stored.
     */
    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const credential = credentialOf(input);
      if (ACCESS_TOKEN_RE.test(credential)) return { ok: false, reasonKey: 'nordvpn.check.networkError' };
      if (!WG_KEY_RE.test(credential)) return { ok: false, reasonKey: 'nordvpn.check.invalidInput' };
      return {
        ok: true,
        label: wgKeyLabel(credential),
        secret: { kind: 'wgkey', privateKey: credential },
        meta: {},
      };
    },

    async targets(_account: Account): Promise<Target[]> {
      return (await loadLocations()).map(toTarget);
    },

    bind(target: Target, serverIp: string, _account: Account, secret: AccountSecret) {
      if (secret.kind !== 'wgkey') throw new Error('nordvpn: bind() requires a wgkey secret');
      const location = readServersCacheSync(cachePath)?.find((l) => l.key === target.key);
      const server = location?.servers.find((s) => s.ip === serverIp);
      if (!server) {
        throw new Error(`nordvpn: no cached server ${serverIp} for "${target.key}" — refresh the server list (call targets()) first`);
      }
      return {
        type: 'wireguard' as const,
        address: [NORDLYNX_ADDRESS],
        private_key: secret.privateKey,
        mtu: 1280,
        peers: [
          {
            address: server.ip,
            port: WG_PORT,
            public_key: server.publicKey,
            allowed_ips: ['0.0.0.0/0'],
            persistent_keepalive_interval: 25,
          },
        ],
      };
    },
  };
}
