/**
 * Bundled ZoogVPN server list (spec §5.2), committed at
 * `app/resources/catalogs/zoogvpn-servers.json`: one entry per host.
 *
 * Originally the `remote`/`proto` lines of every `*.ovpn` file in
 * `haugene/vpn-configs-contrib/openvpn/zoogvpn/`; since rev 3 it is
 * maintained by `pnpm scan:zoog-servers` (scripts/zoog-scan-servers.ts),
 * which adds the numbered hosts that list missed and drops hosts that no
 * longer resolve. Hosts stay hostnames; the controller resolves them before
 * bind (§6.1.4).
 */
import { readFileSync } from 'node:fs';
import { resourcePath } from '../../resources-root';

export interface ZoogServer {
  host: string;
  country: string;
  countryName: string;
  /** See host-scan.ts for how a host's city is attributed. */
  city: string;
  protos: { udp?: number; tcp?: number };
}

interface ServersFile {
  /** Date of the last enumeration (YYYY-MM-DD). */
  scanned?: string;
  servers: ZoogServer[];
}

export function loadServers(serversPath: string = resourcePath('catalogs', 'zoogvpn-servers.json')): ZoogServer[] {
  const text = readFileSync(serversPath, 'utf8');
  const parsed = JSON.parse(text) as ServersFile;
  return parsed.servers;
}
