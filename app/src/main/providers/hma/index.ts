/**
 * HMA provider — OpenVPN with device credentials (spec §5.1).
 *
 * macOS reads `tokenCoreSE.json` and calls `parseDeviceCreds` (./token.ts);
 * that file-read lives in the controller (it owns the file watch and
 * lazy-apply-on-reconnect behaviour), which then calls `check()` here with
 * the extracted `{udid, password}` to validate and wrap them as a secret.
 *
 * TODO(windows, spec §7/§12): Windows reads
 * `%ProgramData%\Privax\HMA VPN\HmaProVpn\auth` (line 1 user, line 2 pass)
 * via the Helper, admin-only, rotated periodically, and it is UNVERIFIED
 * whether that file holds the same udid/password shape. Out of scope for
 * this module per the dispatch; whoever wires the Windows helper should
 * confirm the shape and either reuse `check()` as-is or add a Windows-only
 * parser alongside `./token.ts`.
 */
import type { Account, AccountSecret, Catalog, CheckResult, Provider, Target } from '../types';
import { loadCaLines } from './ca';
import { loadSeed } from './catalog';

const SERVER_PORT = 1194;
const SERVER_NAME = 'openvpn.gen-vpn.com';
const MTU = 1400;

const UDID_RE = /^U1\./;
const PASSWORD_RE = /^[0-9a-fA-F]{64}$/;

export interface HmaProviderDeps {
  loadCatalog?: () => Promise<Catalog>;
  caLines?: string[];
}

export function createHmaProvider(deps: HmaProviderDeps = {}): Provider {
  const loadCatalog = deps.loadCatalog ?? (() => loadSeed());
  let caLinesCache: string[] | undefined = deps.caLines;
  const getCaLines = () => (caLinesCache ??= loadCaLines());

  return {
    id: 'hma',

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const udid = input.udid ?? '';
      const password = input.password ?? '';

      if (!UDID_RE.test(udid)) {
        return { ok: false, reasonKey: 'hma.check.invalidUdid' };
      }
      if (!PASSWORD_RE.test(password)) {
        return { ok: false, reasonKey: 'hma.check.invalidPassword' };
      }

      return {
        ok: true,
        label: `device …${udid.slice(-6)}`,
        secret: { kind: 'userpass', username: udid, password },
        meta: { udid },
      };
    },

    async targets(_account: Account): Promise<Target[]> {
      const catalog = await loadCatalog();
      return catalog.locations.map((loc) => ({
        key: `hma:${loc.key}`,
        providerId: 'hma',
        country: loc.country,
        city: loc.city,
        label: loc.city,
        // Target.servers is "best first" (contracts.ts): most recently
        // confirmed-ok IP first (nulls — never confirmed — last), then the
        // longest-known IP first as a tiebreak.
        servers: [...loc.ips]
          .sort((a, b) => {
            if (a.lastOk !== b.lastOk) {
              if (a.lastOk === null) return 1;
              if (b.lastOk === null) return -1;
              return b.lastOk - a.lastOk;
            }
            return b.firstSeen - a.firstSeen;
          })
          .map((ip) => ip.ip),
      }));
    },

    bind(_target: Target, serverIp: string, _account: Account, secret: AccountSecret) {
      if (secret.kind !== 'userpass') {
        throw new Error('hma: bind() requires a userpass secret (username = udid, password = device password)');
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
          server_name: SERVER_NAME,
          remote_certificate_tls: 'server' as const,
        },
        data_ciphers: ['AES-256-GCM'],
        data_ciphers_fallback: 'AES-256-GCM',
        route_no_pull: true as const,
        explicit_exit_notify: 2,
        mtu: MTU,
      };
    },
  };
}

export const hmaProvider = createHmaProvider();
