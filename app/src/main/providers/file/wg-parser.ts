/**
 * Parse a dropped WireGuard `.conf` (wg-quick format) into the fields
 * needed to build a WireguardEndpoint (spec §5.4).
 *
 * Only a single `[Peer]` is supported (sing-box's WireguardEndpoint takes
 * one peer per outbound here — multi-peer mesh configs are out of scope).
 * `DNS`/`Table`/`SaveConfig`/`FwMark` are accepted and ignored (DNS routing
 * is handled once, globally, by the engine — spec §6.1.4). Hook directives
 * (`PreUp`/`PostUp`/`PreDown`/`PostDown`) and anything else unrecognised
 * are rejected rather than silently dropped.
 */
import { UnsupportedDirectiveError } from './errors';

export interface ParsedWireguard {
  address: string[];
  privateKey?: string;
  mtu?: number;
  peerPublicKey: string;
  presharedKey?: string;
  endpointHost: string;
  endpointPort: number;
  allowedIps: string[];
  keepalive?: number;
}

const IGNORABLE_INTERFACE_KEYS = new Set(['dns', 'table', 'saveconfig', 'fwmark']);
const IGNORABLE_PEER_KEYS = new Set<string>([]);

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith('#') || t.startsWith(';');
}

export function parseWireguardConf(content: string): ParsedWireguard {
  const lines = content.split(/\r?\n/);

  let section: 'interface' | 'peer' | undefined;
  let address: string[] = [];
  let privateKey: string | undefined;
  let mtu: number | undefined;
  let peerPublicKey: string | undefined;
  let presharedKey: string | undefined;
  let endpointHost: string | undefined;
  let endpointPort: number | undefined;
  let allowedIps: string[] = [];
  let keepalive: number | undefined;
  let sawPeerSection = false;

  for (const rawLine of lines) {
    if (isCommentOrBlank(rawLine)) continue;
    const line = rawLine.trim();

    const sectionMatch = line.match(/^\[(Interface|Peer)\]$/i);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase() as 'interface' | 'peer';
      if (section === 'peer') {
        if (sawPeerSection) {
          throw new UnsupportedDirectiveError('[Peer]', 'multiple [Peer] sections are unsupported');
        }
        sawPeerSection = true;
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(`file: malformed WireGuard line (expected "Key = value"): ${line}`);
    }
    const key = line.slice(0, eq).trim();
    const keyLower = key.toLowerCase();
    const value = line.slice(eq + 1).trim();

    if (!section) {
      throw new Error(`file: "${key}" appears before any [Interface]/[Peer] section`);
    }

    if (section === 'interface') {
      switch (keyLower) {
        case 'privatekey':
          privateKey = value;
          break;
        case 'address':
          address = value.split(',').map((s) => s.trim());
          break;
        case 'mtu':
          mtu = Number(value);
          break;
        default:
          if (!IGNORABLE_INTERFACE_KEYS.has(keyLower)) {
            throw new UnsupportedDirectiveError(key);
          }
      }
    } else {
      switch (keyLower) {
        case 'publickey':
          peerPublicKey = value;
          break;
        case 'presharedkey':
          presharedKey = value;
          break;
        case 'allowedips':
          allowedIps = value.split(',').map((s) => s.trim());
          break;
        case 'endpoint': {
          const lastColon = value.lastIndexOf(':');
          if (lastColon === -1) {
            throw new Error(`file: Endpoint "${value}" is missing a port`);
          }
          endpointHost = value.slice(0, lastColon);
          endpointPort = Number(value.slice(lastColon + 1));
          break;
        }
        case 'persistentkeepalive':
          keepalive = Number(value);
          break;
        default:
          if (!IGNORABLE_PEER_KEYS.has(keyLower)) {
            throw new UnsupportedDirectiveError(key);
          }
      }
    }
  }

  if (!privateKey) {
    throw new Error('file: .conf is missing [Interface] PrivateKey');
  }
  if (address.length === 0) {
    throw new Error('file: .conf is missing [Interface] Address');
  }
  if (!peerPublicKey) {
    throw new Error('file: .conf is missing [Peer] PublicKey');
  }
  if (!endpointHost || !endpointPort) {
    throw new Error('file: .conf is missing [Peer] Endpoint');
  }
  if (allowedIps.length === 0) {
    throw new Error('file: .conf is missing [Peer] AllowedIPs');
  }

  return {
    address,
    privateKey,
    mtu,
    peerPublicKey,
    presharedKey,
    endpointHost,
    endpointPort,
    allowedIps,
    keepalive,
  };
}
