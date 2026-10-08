/**
 * Sample endpoint specs for tests. All credentials below are dummy
 * placeholders — not real HMA/ZoogVPN/Surfshark secrets (rules.md: never
 * copy real fixture values, dummy inline PEM/keys only).
 */
import type { OpenVpnEndpoint, WireguardEndpoint } from '../../../shared/contracts';

/** Structurally PEM-shaped but not a real certificate. */
const DUMMY_CA_PEM_LINES = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBDUMMYCERTIFICATEDATAFORUNITTESTSONLYNOTAREALCERTIFICATEAAAA',
  'MIIBDUMMYCERTIFICATEDATAFORUNITTESTSONLYNOTAREALCERTIFICATEBBBB',
  '-----END CERTIFICATE-----',
];

export const sampleOpenVpnEndpoint: OpenVpnEndpoint = {
  type: 'openvpn-client',
  server: '198.51.100.10',
  server_port: 1194,
  network: 'udp',
  username: 'dummy-user',
  password: 'dummy-pass',
  tls: {
    certificate: DUMMY_CA_PEM_LINES,
    server_name: 'openvpn.example.test',
    remote_certificate_tls: 'server',
  },
  data_ciphers: ['AES-256-GCM'],
  data_ciphers_fallback: 'AES-256-GCM',
  auth: 'SHA256',
  route_no_pull: true,
  explicit_exit_notify: 2,
  mtu: 1400,
};

export const sampleWireguardEndpoint: WireguardEndpoint = {
  type: 'wireguard',
  address: ['10.14.0.2/16'],
  private_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  mtu: 1280,
  peers: [
    {
      address: '203.0.113.20',
      port: 51820,
      public_key: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      allowed_ips: ['0.0.0.0/0'],
      persistent_keepalive_interval: 25,
    },
  ],
};
