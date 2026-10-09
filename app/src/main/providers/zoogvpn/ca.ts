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
import { resourcePath } from '../../resources-root';
import { linesOfPemBlock } from '../pem';

export function loadCaLines(caPath: string = resourcePath('ca', 'zoogvpn-ca.pem')): string[] {
  return linesOfPemBlock(readFileSync(caPath, 'utf8'), 'zoogvpn');
}

/** tls-auth key lines, with the leading `#` comment lines stripped. */
export function loadTlsAuthLines(keyPath: string = resourcePath('ca', 'zoogvpn-tls-auth.key')): string[] {
  return linesOfPemBlock(readFileSync(keyPath, 'utf8'), 'zoogvpn');
}
