/**
 * ZoogVPN provider — OpenVPN with account username/password (spec §5.2).
 *
 * Note (known gap, see report): the bundled server list carries both a UDP
 * 1194 and a TCP 443 variant per server (`ZoogServer.protos`), matching the
 * spec's "UDP 1194 (and allow TCP 443 variant)". `Provider.bind()` has no
 * protocol parameter in contracts.ts, so this implementation always emits
 * the UDP 1194 variant; wiring a TCP fallback (e.g. when UDP is firewalled)
 * needs either a contracts change or a controller-side decision encoded
 * into `Target`, which is out of this module's scope.
 *
 * Plan-refusal vs wrong-password disambiguation (spec §5.2, ⚠️) is a
 * health/back-off concern (tracking auth failures across servers of the
 * same account over time) and belongs in the health module, not here.
 */
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { loadCaLines, loadTlsAuthLines } from './ca';
import { loadServers, type ZoogServer } from './servers';

const SERVER_PORT = 1194;

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
      const servers = getServers();
      return servers.map((s) => ({
        key: `zoogvpn:${s.key}`,
        providerId: 'zoogvpn',
        country: s.country,
        city: s.city,
        label: `${s.countryName} (${s.host})`,
        servers: [s.host],
      }));
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
