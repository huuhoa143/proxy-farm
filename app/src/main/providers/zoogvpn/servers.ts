/**
 * Bundled ZoogVPN server list (spec §5.2), sourced from the `remote`/`proto`
 * lines of every `*.ovpn` file in
 * `haugene/vpn-configs-contrib/openvpn/zoogvpn/`, committed at
 * `app/resources/catalogs/zoogvpn-servers.json`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SERVERS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../resources/catalogs/zoogvpn-servers.json',
);

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

export function loadServers(serversPath: string = DEFAULT_SERVERS_PATH): ZoogServer[] {
  const text = readFileSync(serversPath, 'utf8');
  const parsed = JSON.parse(text) as ServersFile;
  return parsed.servers;
}
