import type { OpenVpnEndpoint, WireguardEndpoint } from '../types';
import type { ParsedOvpn } from './ovpn-parser';
import type { ParsedWireguard } from './wg-parser';

const DEFAULT_OVPN_MTU = 1400;
const DEFAULT_WG_MTU = 1280;
const MIN_OVPN_MTU = 1280;
const MAX_OVPN_MTU = 1500;

/** Honours a `tun-mtu` from the .ovpn, clamped to [1280, 1500]; falls back to 1400 if absent. */
function resolveOvpnMtu(tunMtu: number | undefined): number {
  if (tunMtu === undefined) return DEFAULT_OVPN_MTU;
  return Math.min(MAX_OVPN_MTU, Math.max(MIN_OVPN_MTU, tunMtu));
}

export function buildOvpnEndpoint(
  parsed: ParsedOvpn,
  serverIp: string,
  creds?: { username: string; password: string },
): OpenVpnEndpoint {
  if (parsed.needsAuthUserPass && !creds) {
    throw new Error('file: this .ovpn needs a username/password (auth-user-pass) but none was supplied');
  }
  return {
    type: 'openvpn-client',
    server: serverIp,
    server_port: parsed.remotePort,
    network: parsed.proto,
    username: creds?.username,
    password: creds?.password,
    tls: {
      certificate: parsed.caLines,
      ...(parsed.serverName ? { server_name: parsed.serverName, server_name_type: parsed.serverNameType } : {}),
      ...(parsed.clientCertLines && parsed.clientKeyLines
        ? { client_certificate: parsed.clientCertLines, client_key: parsed.clientKeyLines }
        : {}),
      remote_certificate_tls: 'server',
      ...(parsed.nsCertType ? { ns_certificate_type: parsed.nsCertType } : {}),
      ...(parsed.tlsAuthLines
        ? { control_wrap: { type: 'tls_auth' as const, key: parsed.tlsAuthLines, direction: parsed.controlWrapDirection } }
        : parsed.tlsCryptLines
          ? { control_wrap: { type: 'tls_crypt' as const, key: parsed.tlsCryptLines, direction: parsed.controlWrapDirection } }
          : {}),
    },
    data_ciphers: parsed.cipher ? [parsed.cipher] : ['AES-256-GCM'],
    auth: parsed.auth,
    ...(parsed.fragment !== undefined ? { fragment: parsed.fragment } : {}),
    ...(parsed.mssFix !== undefined ? { mss_fix: parsed.mssFix } : {}),
    ...(parsed.mssFixMode ? { mss_fix_mode: parsed.mssFixMode } : {}),
    ...(parsed.mssFixDisabled ? { mss_fix_disabled: parsed.mssFixDisabled } : {}),
    ...(parsed.compressionLzo ? { compression_lzo: parsed.compressionLzo } : {}),
    route_no_pull: true,
    mtu: resolveOvpnMtu(parsed.tunMtu),
  };
}

export function buildWireguardEndpoint(
  parsed: ParsedWireguard,
  serverIp: string,
  privateKeyOverride?: string,
): WireguardEndpoint {
  const privateKey = privateKeyOverride ?? parsed.privateKey;
  if (!privateKey) {
    throw new Error('file: no WireGuard private key available (neither in the .conf nor supplied separately)');
  }
  return {
    type: 'wireguard',
    address: parsed.address,
    private_key: privateKey,
    mtu: parsed.mtu ?? DEFAULT_WG_MTU,
    peers: [
      {
        address: serverIp,
        port: parsed.endpointPort,
        public_key: parsed.peerPublicKey,
        pre_shared_key: parsed.presharedKey,
        allowed_ips: parsed.allowedIps,
        persistent_keepalive_interval: parsed.keepalive,
      },
    ],
  };
}
