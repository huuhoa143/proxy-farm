import type { OpenVpnEndpoint, WireguardEndpoint } from '../types';
import type { ParsedOvpn } from './ovpn-parser';
import type { ParsedWireguard } from './wg-parser';

const DEFAULT_OVPN_MTU = 1400;
const DEFAULT_WG_MTU = 1280;

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
      remote_certificate_tls: 'server',
      ...(parsed.tlsAuthLines
        ? { control_wrap: { type: 'tls_auth' as const, key: parsed.tlsAuthLines, direction: parsed.controlWrapDirection } }
        : parsed.tlsCryptLines
          ? { control_wrap: { type: 'tls_crypt' as const, key: parsed.tlsCryptLines, direction: parsed.controlWrapDirection } }
          : {}),
    },
    data_ciphers: parsed.cipher ? [parsed.cipher] : ['AES-256-GCM'],
    auth: parsed.auth,
    route_no_pull: true,
    mtu: DEFAULT_OVPN_MTU,
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
