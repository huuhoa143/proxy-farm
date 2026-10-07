/**
 * Bundled ZoogVPN server list (spec §5.2), sourced from the `remote`/`proto`
 * lines of every `*.ovpn` file in
 * `haugene/vpn-configs-contrib/openvpn/zoogvpn/`, committed at
 * `app/resources/catalogs/zoogvpn-servers.json`.
 */
import { readFileSync } from 'node:fs';
import { resourcePath } from '../../resources-root';

export interface ZoogServer {
  key: string;
  host: string;
  country: string;
  countryName: string;
  city: string;
  protos: { udp?: number; tcp?: number };
}

interface ServersFile {
  servers: ZoogServer[];
}

export function loadServers(serversPath: string = resourcePath('catalogs', 'zoogvpn-servers.json')): ZoogServer[] {
  const text = readFileSync(serversPath, 'utf8');
  const parsed = JSON.parse(text) as ServersFile;
  return parsed.servers;
}
