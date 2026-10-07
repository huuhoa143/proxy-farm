/**
 * Parse a dropped `.ovpn` file into the pieces needed to build an
 * OpenVpnEndpoint (spec §5.4): remote, proto, cipher, auth, inline ca,
 * inline tls-auth/tls-crypt, and auth-user-pass (which means "prompt the
 * user for credentials" rather than anything embedded in the file).
 *
 * Directives this app doesn't act on, but which don't affect the rendered
 * endpoint, are silently ignored (IGNORABLE_DIRECTIVES). Anything else —
 * shell hooks (`up`/`down`), client-certificate auth (`<cert>`/`<key>`),
 * externally-referenced CA/key files, routing/DNS overrides, etc. — is
 * rejected with `UnsupportedDirectiveError` rather than silently dropped,
 * per spec §5.4.
 */
import { UnsupportedDirectiveError } from './errors';

export interface ParsedOvpn {
  remoteHost: string;
  remotePort: number;
  proto: 'udp' | 'tcp';
  cipher?: string;
  auth?: string;
  caLines: string[];
  tlsAuthLines?: string[];
  tlsCryptLines?: string[];
  controlWrapDirection?: 'client';
  needsAuthUserPass: boolean;
  /** Raw `tun-mtu <n>` value, if present and numeric. Clamping/defaulting happens in endpoint-builder.ts. */
  tunMtu?: number;
}

const IGNORABLE_DIRECTIVES = new Set([
  'client',
  'dev',
  'resolv-retry',
  'nobind',
  'persist-key',
  'persist-tun',
  'persist-remote-ip',
  'fast-io',
  'reneg-sec',
  'reneg-bytes',
  'verb',
  'auth-nocache',
  'explicit-exit-notify',
  'remote-cert-tls',
  'mssfix',
  'comp-lzo',
  'compress',
  'float',
  'tls-client',
  'tls-version-min',
]);

// Blocks (<tag>...</tag>) we understand. `cert`/`key`/`pkcs12`/`extra-certs`
// imply client-certificate auth, which OpenVpnEndpoint has no field for.
const SUPPORTED_BLOCKS = new Set(['ca', 'tls-auth', 'tls-crypt']);

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith('#') || t.startsWith(';');
}

export function parseOvpn(content: string): ParsedOvpn {
  const lines = content.split(/\r?\n/);

  let remoteHost: string | undefined;
  let remotePort: number | undefined;
  let proto: 'udp' | 'tcp' = 'udp';
  let cipher: string | undefined;
  let auth: string | undefined;
  let caLines: string[] | undefined;
  let tlsAuthLines: string[] | undefined;
  let tlsCryptLines: string[] | undefined;
  let keyDirection: string | undefined;
  let needsAuthUserPass = false;
  let tunMtu: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOrBlank(line)) continue;

    const blockOpen = line.trim().match(/^<([a-zA-Z0-9_-]+)>$/);
    if (blockOpen) {
      const tag = blockOpen[1].toLowerCase();
      const closeTag = `</${tag}>`;
      const blockLines: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j].trim() !== closeTag; j++) {
        blockLines.push(lines[j]);
      }
      if (j >= lines.length) {
        throw new Error(`file: unterminated <${tag}> block`);
      }
      if (!SUPPORTED_BLOCKS.has(tag)) {
        throw new UnsupportedDirectiveError(`<${tag}>`, 'client-certificate or unrecognised inline block');
      }
      const pemLines = extractPemLines(blockLines);
      if (tag === 'ca') caLines = pemLines;
      if (tag === 'tls-auth') tlsAuthLines = pemLines;
      if (tag === 'tls-crypt') tlsCryptLines = pemLines;
      i = j; // skip past the closing tag
      continue;
    }

    const [directive, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');

    switch (directive) {
      case 'remote': {
        const [host, portStr] = rest;
        remoteHost = host;
        remotePort = portStr ? Number(portStr) : 1194;
        break;
      }
      case 'proto':
        if (arg !== 'udp' && arg !== 'tcp') {
          throw new UnsupportedDirectiveError('proto', arg);
        }
        proto = arg;
        break;
      case 'cipher':
        cipher = arg;
        break;
      case 'auth':
        auth = arg;
        break;
      case 'auth-user-pass':
        if (arg.length > 0) {
          // `auth-user-pass <file>` references an external credentials file.
          throw new UnsupportedDirectiveError('auth-user-pass', 'external credentials file is unsupported');
        }
        needsAuthUserPass = true;
        break;
      case 'key-direction':
        keyDirection = arg;
        break;
      case 'tun-mtu': {
        const n = Number(arg);
        // An invalid value isn't fatal — endpoint-builder falls back to the
        // default MTU exactly as if `tun-mtu` had been absent.
        if (Number.isFinite(n)) tunMtu = n;
        break;
      }
      case 'ca':
      case 'tls-auth':
      case 'tls-crypt':
      case 'cert':
      case 'key':
      case 'pkcs12':
        // bare directive form references an external file path we can't inline.
        throw new UnsupportedDirectiveError(directive, 'external file reference is unsupported, use an inline <tag> block');
      default:
        if (!IGNORABLE_DIRECTIVES.has(directive)) {
          throw new UnsupportedDirectiveError(directive);
        }
    }
  }

  if (!remoteHost || !remotePort) {
    throw new Error('file: .ovpn is missing a `remote <host> <port>` directive');
  }
  if (!caLines) {
    throw new Error('file: .ovpn is missing an inline <ca> block');
  }

  // `keyDirection` (0/1/bidirectional) only ever maps to 'client' here: sing-box's
  // control_wrap direction field has no other literal in contracts.ts, and every
  // real-world sample inlines tls-auth from the client's perspective. We still
  // parse it above (so an absent/garbled value doesn't silently pass through
  // the default branch as an unsupported directive) but don't branch on it.
  void keyDirection;

  return {
    remoteHost,
    remotePort,
    proto,
    cipher,
    auth,
    caLines,
    tlsAuthLines,
    tlsCryptLines,
    controlWrapDirection: tlsAuthLines || tlsCryptLines ? 'client' : undefined,
    needsAuthUserPass,
    tunMtu,
  };
}

function extractPemLines(blockLines: string[]): string[] {
  const start = blockLines.findIndex((l) => l.trim().startsWith('-----BEGIN'));
  const end = blockLines.findIndex((l) => l.trim().startsWith('-----END'));
  if (start === -1 || end === -1 || end < start) {
    throw new Error('file: inline block is missing a -----BEGIN/-----END PEM payload');
  }
  return blockLines.slice(start, end + 1).map((l) => l.trim());
}
