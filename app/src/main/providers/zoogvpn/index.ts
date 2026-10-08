/**
 * ZoogVPN provider — OpenVPN with account username/password (spec §5.2).
 *
 * A target is a location (country, city) whose servers are its numbered
 * hosts (spec §6.8); before rev 3 every host was its own target.
 *
 * Note (known gap, see report): the bundled server list carries both a UDP
 * 1194 and a TCP 443 variant per server (`ZoogServer.protos`), matching the
 * spec's "UDP 1194 (and allow TCP 443 variant)". `Provider.bind()` has no
 * protocol parameter in contracts.ts, so this implementation always emits
 * the UDP 1194 variant; wiring a TCP fallback (e.g. when UDP is firewalled)
 * needs either a contracts change or a controller-side decision encoded
 * into `Target`, which is out of this module's scope.
 *
 * Plan refusal vs wrong password (spec §5.2): both arrive as `AUTH_FAILED`.
 * This module only says which hosts are on the free tier (`freeTierServers`);
 * the controller's credential probe (controller/credential-probe.ts) asks one
 * of them to tell the two apart.
 */
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { loadCaLines, loadTlsAuthLines } from './ca';
import { loadServers, type ZoogServer } from './servers';

const SERVER_PORT = 1194;

/** ZoogVPN's free-tier hosts (`nl.zgfree.info`, `uk.zgfree.info`, `us.zgfree.info`):
 * every account may use them, whatever its plan (✅ 2026-10-09). */
export function isFreeTierHost(host: string): boolean {
  return /\.zgfree\.info$/i.test(host);
}

/**
 * Location key (spec §6.8): `zoogvpn:<CC>` for a country-wide location (the
 * city is the country name, i.e. ZoogVPN names no city), otherwise
 * `zoogvpn:<CC>-<CITY>` with the city upper-cased and non-alphanumerics
 * turned into `-` (`zoogvpn:US-EAST`), in the style of HMA's
 * `hma:JP-40-TOKYO-ULT`. Derived from data only, so it is stable across
 * server-list updates.
 */
export function zoogLocationKey(country: string, city: string, countryName: string): string {
  if (city === countryName || city === '') return `zoogvpn:${country}`;
  const slug = city
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `zoogvpn:${country}-${slug}`;
}

/**
 * One target per (country, city); its servers are the hostnames of that
 * location in list order (by host number; host-scan.ts `sortServers`).
 * Hosts sharing an IP across locations are left to the controller, which
 * compares resolved IPs (§6.8).
 */
export function groupLocations(servers: ZoogServer[]): Target[] {
  const byKey = new Map<string, Target>();
  for (const s of servers) {
    const key = zoogLocationKey(s.country, s.city, s.countryName);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.servers.includes(s.host)) existing.servers.push(s.host);
    } else {
      byKey.set(key, {
        key,
        providerId: 'zoogvpn',
        country: s.country,
        city: s.city,
        label: s.city === s.countryName || s.city === '' ? s.countryName : `${s.countryName} — ${s.city}`,
        servers: [s.host],
      });
    }
    const target = byKey.get(key)!;
    if (isFreeTierHost(s.host) && !target.freeTierServers?.includes(s.host)) target.freeTierServers = [...(target.freeTierServers ?? []), s.host];
  }
  return [...byKey.values()];
}

export interface ZoogvpnProviderDeps {
  loadServers?: () => ZoogServer[];
  caLines?: string[];
  tlsAuthLines?: string[];
}

export function createZoogvpnProvider(deps: ZoogvpnProviderDeps = {}): Provider {
  const getServers = deps.loadServers ?? loadServers;
  let caLinesCache: string[] | undefined = deps.caLines;
  let tlsAuthCache: string[] | undefined = deps.tlsAuthLines;
  const getCaLines = () => (caLinesCache ??= loadCaLines());
  const getTlsAuthLines = () => (tlsAuthCache ??= loadTlsAuthLines());

  return {
    id: 'zoogvpn',

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const username = input.username ?? '';
      const password = input.password ?? '';
      if (username.length === 0) {
        return { ok: false, reasonKey: 'zoogvpn.check.missingUsername' };
      }
      if (password.length === 0) {
        return { ok: false, reasonKey: 'zoogvpn.check.missingPassword' };
      }
      return {
        ok: true,
        label: username,
        secret: { kind: 'userpass', username, password },
        meta: { username },
      };
    },

    async targets(_account: Account): Promise<Target[]> {
      return groupLocations(getServers());
    },

    bind(_target: Target, serverIp: string, _account: Account, secret: AccountSecret) {
      if (secret.kind !== 'userpass') {
        throw new Error('zoogvpn: bind() requires a userpass secret');
      }
      return {
        type: 'openvpn-client' as const,
        server: serverIp,
        server_port: SERVER_PORT,
        network: 'udp' as const,
        username: secret.username,
        password: secret.password,
        tls: {
          certificate: getCaLines(),
          remote_certificate_tls: 'server' as const,
          control_wrap: {
            type: 'tls_auth' as const,
            key: getTlsAuthLines(),
            direction: 'client' as const,
          },
        },
        data_ciphers: ['AES-256-GCM'],
        auth: 'SHA256',
        route_no_pull: true as const,
        explicit_exit_notify: 2,
        mtu: 1400,
      };
    },
  };
}

export const zoogvpnProvider = createZoogvpnProvider();
