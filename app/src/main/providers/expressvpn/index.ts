/**
 * ExpressVPN provider — OpenVPN with the account's manual-configuration username and
 * password (spec §5.6).
 *
 * The credentials are the "Manual configuration → OpenVPN" Username and Password of the
 * ExpressVPN account page: generated strings (24 lowercase letters and digits each in
 * our sample), NOT the account's email/password and NOT its activation code. Everything
 * else in the profile is shared by every customer and bundled (profile.ts).
 *
 * ExpressVPN has no plans that limit servers: every server takes every valid login, so
 * an `AUTH_FAILED` anywhere means the username/password are wrong, and a single test
 * connection to any server checks them (`anyServerChecksLogin`, controller/
 * credential-probe.ts). Its app's own per-connection token ("jwt-auth" + a ~960-character
 * JWT) is refused by the servers for non-ExpressVPN clients ("Maximum length is 128
 * bytes"), so it is not supported.
 *
 * A target is a location of the bundled catalog (servers.ts); its servers are the A
 * records of the location's hostnames, discovered and kept by the same DNS pool store as
 * Surfshark's (surfshark/pool.ts), persisted beside it. Until a hostname's first answer
 * lands, the hostname itself stands in (`poolHostnames`) and the controller resolves it.
 *
 * Exit IP (✅ 2026-10-09): fixed per server across reconnects, but not the server's own
 * IP (.69 always exits as .47; .200 as .62) — `EXIT_IP_MODELS.expressvpn = 'server'`.
 */
import type { Account, AccountSecret, CheckResult, OpenVpnEndpoint, Provider, Target } from '../types';
import { createSurfsharkPools, type PoolNet, type SurfsharkPools } from '../surfshark/pool';
import { loadProfile, type ExpressProfile } from './profile';
import { groupLocations, loadServers, type ExpressServer } from './servers';

const SERVER_PORT = 1195;
/** ExpressVPN servers refuse a longer username or password (spec §5.6). */
const MAX_CREDENTIAL_BYTES = 128;

/** Stored account label: `user …<last 6 of the username>`. The username is half of the
 * credential, so it is not shown whole (the renderer localises the template). */
export function expressUserLabel(username: string): string {
  return `user …${username.slice(-6)}`;
}

export interface ExpressvpnProviderDeps {
  /** Required: where the discovered server pools live (no cwd default). */
  poolPath: string;
  loadServers?: () => ExpressServer[];
  /** DNS access for pool discovery (tests inject a fake). */
  poolNet?: PoolNet;
  /** A ready-made pool store; overrides `poolPath` / `poolNet`. */
  pools?: SurfsharkPools;
  profile?: ExpressProfile;
}

export function createExpressvpnProvider(deps: ExpressvpnProviderDeps): Provider {
  const getServers = deps.loadServers ?? loadServers;
  // A location's A records hardly change: two lookups per refresh are plenty.
  const pools = deps.pools ?? createSurfsharkPools({ poolPath: deps.poolPath, net: deps.poolNet, rounds: 2 });
  let profileCache = deps.profile;
  const profile = () => (profileCache ??= loadProfile());

  return {
    id: 'expressvpn',
    anyServerChecksLogin: true,

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const username = (input.username ?? '').trim();
      const password = (input.password ?? '').trim();
      if (username.length === 0) return { ok: false, reasonKey: 'expressvpn.check.missingUsername' };
      if (password.length === 0) return { ok: false, reasonKey: 'expressvpn.check.missingPassword' };
      // The account's email: the manual-configuration username never has an @.
      if (username.includes('@')) return { ok: false, reasonKey: 'expressvpn.check.notManualCredentials' };
      if (Buffer.byteLength(username) > MAX_CREDENTIAL_BYTES || Buffer.byteLength(password) > MAX_CREDENTIAL_BYTES) {
        return { ok: false, reasonKey: 'expressvpn.check.tooLong' };
      }
      return {
        ok: true,
        label: expressUserLabel(username),
        secret: { kind: 'userpass', username, password },
        meta: {},
      };
    },

    async targets(_account: Account): Promise<Target[]> {
      const locations = groupLocations(getServers());
      await pools.ensure(locations.flatMap((t) => t.servers));
      return locations.map((t) => {
        const ips = [...new Set(t.servers.flatMap((host) => pools.servers(host)))];
        return { ...t, servers: ips.length > 0 ? ips : t.servers, poolHostnames: true };
      });
    },

    bind(_target: Target, serverIp: string, _account: Account, secret: AccountSecret): OpenVpnEndpoint {
      if (secret.kind !== 'userpass') {
        throw new Error('expressvpn: bind() requires a userpass secret');
      }
      const p = profile();
      // ✅ 2026-10-09 with sing-box 1.14.2: without `fragment` the tunnel comes up and
      // carries no data; the rest matches ExpressVPN's own profile.
      return {
        type: 'openvpn-client',
        server: serverIp,
        server_port: SERVER_PORT,
        network: 'udp',
        username: secret.username,
        password: secret.password,
        tls: {
          server_name: 'Server',
          server_name_type: 'name-prefix',
          certificate: p.caLines,
          client_certificate: p.certLines,
          client_key: p.keyLines,
          ns_certificate_type: 'server',
          control_wrap: { type: 'tls_auth', key: p.tlsAuthLines, direction: 'client' },
        },
        data_ciphers: ['AES-256-GCM'],
        auth: 'SHA512',
        fragment: 1300,
        mss_fix: 1200,
        compression_lzo: 'no',
        route_no_pull: true,
        mtu: 1500,
      };
    },
  };
}
