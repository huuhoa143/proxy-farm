/**
 * ZoogVPN's shared "Easy-RSA CA" (valid to 2032) and shared tls-auth static
 * key (spec §5.2). Both are the SAME for every customer and every server in
 * the bundle (verified: identical across all `*.ovpn` files in
 * `haugene/vpn-configs-contrib/openvpn/zoogvpn/`, bar two outlier servers
 * that use their own tls-auth key — this is the majority/common one), so
 * they are bundled resources, not per-account secrets.
 *
 * Source: `ca1.zoogvpn.com.udp.ovpn` from
 * https://github.com/haugene/vpn-configs-contrib (openvpn/zoogvpn/).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CA_PATH = path.join(MODULE_DIR, '../../../../resources/ca/zoogvpn-ca.pem');
export const DEFAULT_TLS_AUTH_PATH = path.join(MODULE_DIR, '../../../../resources/ca/zoogvpn-tls-auth.key');

function linesOfPemBlock(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  const end = lines.findIndex((l) => l.startsWith('-----END'));
  if (start === -1 || end === -1 || end < start) {
    throw new Error('zoogvpn: expected a -----BEGIN/-----END PEM block');
  }
  return lines.slice(start, end + 1);
}

export function loadCaLines(caPath: string = DEFAULT_CA_PATH): string[] {
  return linesOfPemBlock(readFileSync(caPath, 'utf8'));
}

/** tls-auth key lines, with the leading `#` comment lines stripped. */
export function loadTlsAuthLines(keyPath: string = DEFAULT_TLS_AUTH_PATH): string[] {
  return linesOfPemBlock(readFileSync(keyPath, 'utf8'));
}
