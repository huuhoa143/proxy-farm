/**
 * The parts of ExpressVPN's OpenVPN profile that are the SAME for every customer
 * (spec §5.6): the "ExpressVPN CA3" root (valid to 2124), the client certificate
 * (CN `expressvpn_customer`, valid to 2066) with its key, and the tls-auth static key.
 * What tells accounts apart is only the manual-configuration username/password.
 *
 * Taken from a "Manual configuration → OpenVPN" download (2026-10-09); byte-identical to
 * gluetun's `internal/provider/expressvpn/openvpnconf.go` (MIT). The download also names
 * an older CA that expired on 2026-04-01; servers chain to CA3, so only CA3 is bundled.
 */
import { readFileSync } from 'node:fs';
import { resourcePath } from '../../resources-root';
import { linesOfPemBlock } from '../pem';

export interface ExpressProfile {
  caLines: string[];
  certLines: string[];
  keyLines: string[];
  tlsAuthLines: string[];
}

function load(file: string): string[] {
  return linesOfPemBlock(readFileSync(resourcePath('ca', file), 'utf8'), 'expressvpn');
}

export function loadProfile(): ExpressProfile {
  return {
    caLines: load('expressvpn-ca.pem'),
    certLines: load('expressvpn-client.crt'),
    keyLines: load('expressvpn-client.key'),
    tlsAuthLines: load('expressvpn-tls-auth.key'),
  };
}
