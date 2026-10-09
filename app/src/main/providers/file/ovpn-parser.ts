/**
 * Parse a dropped `.ovpn` file into the pieces needed to build an
 * OpenVpnEndpoint (spec §5.4): remote, proto, cipher, auth, inline ca,
 * inline tls-auth/tls-crypt, an inline client certificate and key
 * (`<cert>` + `<key>`, both or neither), `fragment`, `mssfix`, `comp-lzo no`,
 * `verify-x509-name`, `ns-cert-type server`, and auth-user-pass (which means
 * "prompt the user for credentials" rather than anything embedded in the file).
 *
 * Directives this app doesn't act on, but which don't affect the rendered
 * endpoint, are silently ignored (IGNORABLE_DIRECTIVES). Anything else —
 * shell hooks (`up`/`down`), PKCS#12 bundles, externally-referenced CA/key
 * files, routing/DNS overrides, etc. — is rejected with
 * `UnsupportedDirectiveError` rather than silently dropped, per spec §5.4.
 *
 * Every `remote` line is kept (spec §5.4 rev 3): the file's server pool is the
 * distinct hosts of its remotes, in file order. `bind()` only receives the
 * resolved IP of the chosen server, not which line it came from, so a server
 * must not need its own port or protocol: the pool keeps only the remotes that
 * share the first remote's port and protocol. Today's single-remote behaviour
 * (first remote wins) is the degenerate case.
 */
import { UnsupportedDirectiveError } from './errors';

export interface OvpnRemote {
  host: string;
  port: number;
  proto: 'udp' | 'tcp';
}

export interface ParsedOvpn {
  /** The first `remote` line; its port and protocol apply to every server of the pool. */
  remoteHost: string;
  remotePort: number;
  proto: 'udp' | 'tcp';
  /** Every `remote` line, in file order. */
  remotes: OvpnRemote[];
  /** The file's server pool: distinct hosts of the remotes sharing the first remote's port and protocol. */
  servers: string[];
  cipher?: string;
  auth?: string;
  caLines: string[];
  tlsAuthLines?: string[];
  tlsCryptLines?: string[];
  controlWrapDirection?: 'client';
  needsAuthUserPass: boolean;
  /** Raw `tun-mtu <n>` value, if present and numeric. Clamping/defaulting happens in endpoint-builder.ts. */
  tunMtu?: number;
  /** Inline `<cert>` / `<key>`: client-certificate auth. Always both or neither. */
  clientCertLines?: string[];
  clientKeyLines?: string[];
  /** `fragment <n>`; `fragment 0` (no fragmentation, OpenVPN's default) leaves it unset. */
  fragment?: number;
  /** `mssfix <n> [mtu|fixed]`; a bare `mssfix` (OpenVPN's default) leaves all three unset. */
  mssFix?: number;
  mssFixMode?: 'mtu' | 'fixed';
  /** `mssfix 0`: no clamping. Distinct from unset, where sing-box clamps by default. */
  mssFixDisabled?: true;
  /** `comp-lzo no`. Other `comp-lzo` values stay ignored, as they always were. */
  compressionLzo?: 'no';
  /** `verify-x509-name <name> [subject|name|name-prefix]`; OpenVPN's default type is subject. */
  serverName?: string;
  serverNameType?: 'subject' | 'name' | 'name-prefix';
  /** `ns-cert-type server`. */
  nsCertType?: 'server';
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
  'compress',
  'float',
  'tls-client',
  'tls-version-min',
  // Order of the remotes only; the controller picks servers from the pool itself.
  'remote-random',
  // A client always pulls its options; `client` implies it.
  'pull',
  // Windows route installation and socket buffer sizes: sing-box installs no routes
  // (route_no_pull) and sizes its own sockets.
  'route-method',
  'route-delay',
  'sndbuf',
  'rcvbuf',
]);

// Blocks (<tag>...</tag>) we understand. `pkcs12`/`extra-certs` have no
// OpenVpnEndpoint field.
const SUPPORTED_BLOCKS = new Set(['ca', 'tls-auth', 'tls-crypt', 'cert', 'key']);

const X509_NAME_TYPES = new Set(['subject', 'name', 'name-prefix']);

// sing-box refuses a smaller `fragment` when the tunnel starts.
const MIN_FRAGMENT = 68;
// `mssfix <n> fixed` subtracts the IPv4 and TCP headers from n; sing-box doesn't check it.
const MIN_FIXED_MSSFIX = 41;

/** A whole number of bytes (0 allowed: OpenVPN's "off"), or an `UnsupportedDirectiveError` naming `directive`. */
function byteCount(directive: string, arg: string): number {
  const n = Number(arg);
  if (!/^\d+$/.test(arg) || n > 65535) throw new UnsupportedDirectiveError(directive, `"${arg}" is not a size in bytes`);
  return n;
}

/** `fragment <n> [mtu]`; undefined for `fragment 0`. sing-box has no field for the `mtu` mode. */
function parseFragment(args: string[]): number | undefined {
  if (args.length !== 1) throw new UnsupportedDirectiveError('fragment', `"${args.join(' ')}" (only a size is supported)`);
  const n = byteCount('fragment', args[0]);
  if (n === 0) return undefined;
  if (n < MIN_FRAGMENT) throw new UnsupportedDirectiveError('fragment', `${n} is below ${MIN_FRAGMENT} bytes`);
  return n;
}

/** `mssfix <n> [mtu|fixed]` (not bare `mssfix`), read as OpenVPN 2.6 does: 0 turns clamping off. */
function parseMssfix(args: string[]): Pick<ParsedOvpn, 'mssFix' | 'mssFixMode' | 'mssFixDisabled'> {
  const [size, mode, ...extra] = args;
  if (extra.length > 0 || (mode !== undefined && mode !== 'mtu' && mode !== 'fixed')) {
    throw new UnsupportedDirectiveError('mssfix', `"${args.join(' ')}"`);
  }
  const n = byteCount('mssfix', size);
  if (n === 0) return { mssFixDisabled: true };
  if (mode === 'fixed' && n < MIN_FIXED_MSSFIX) {
    throw new UnsupportedDirectiveError('mssfix', `${n} fixed leaves no room for the IPv4 and TCP headers`);
  }
  return { mssFix: n, ...(mode ? { mssFixMode: mode } : {}) };
}

/** `verify-x509-name` arguments: a name, possibly quoted (subjects contain spaces), then an optional type. */
function parseX509Name(arg: string): { name: string; type: 'subject' | 'name' | 'name-prefix' } {
  const m = arg.match(/^(?:"([^"]*)"|'([^']*)'|(\S+))\s*(\S+)?$/);
  const name = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  const type = m?.[4] ?? 'subject';
  if (!name) throw new UnsupportedDirectiveError('verify-x509-name', 'a name is required');
  if (!X509_NAME_TYPES.has(type)) throw new UnsupportedDirectiveError('verify-x509-name', `type ${type}`);
  return { name, type: type as 'subject' | 'name' | 'name-prefix' };
}

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith('#') || t.startsWith(';');
}

export function parseOvpn(content: string): ParsedOvpn {
  const lines = content.split(/\r?\n/);

  // A remote's own protocol (third argument) wins; otherwise the file's `proto`,
  // which may appear after the remote lines, so it is applied after the loop.
  const rawRemotes: Array<{ host: string; port: number; proto?: 'udp' | 'tcp' }> = [];
  let proto: 'udp' | 'tcp' = 'udp';
  let cipher: string | undefined;
  let auth: string | undefined;
  let caLines: string[] | undefined;
  let tlsAuthLines: string[] | undefined;
  let tlsCryptLines: string[] | undefined;
  let keyDirection: string | undefined;
  let needsAuthUserPass = false;
  let tunMtu: number | undefined;
  let clientCertLines: string[] | undefined;
  let clientKeyLines: string[] | undefined;
  let fragment: number | undefined;
  let mss: Pick<ParsedOvpn, 'mssFix' | 'mssFixMode' | 'mssFixDisabled'> = {};
  let compressionLzo: 'no' | undefined;
  let x509Name: { name: string; type: 'subject' | 'name' | 'name-prefix' } | undefined;
  let nsCertType: 'server' | undefined;

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
        throw new UnsupportedDirectiveError(`<${tag}>`, 'unrecognised inline block');
      }
      const pemLines = extractPemLines(blockLines);
      if (tag === 'ca') caLines = pemLines;
      if (tag === 'tls-auth') tlsAuthLines = pemLines;
      if (tag === 'tls-crypt') tlsCryptLines = pemLines;
      if (tag === 'cert') clientCertLines = pemLines;
      if (tag === 'key') clientKeyLines = pemLines;
      i = j; // skip past the closing tag
      continue;
    }

    const [directive, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');

    switch (directive) {
      case 'remote': {
        const [host, portStr, remoteProto] = rest;
        if (!host) break; // caught below as "missing remote" if no other remote exists
        const port = portStr ? Number(portStr) : 1194;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`file: remote "${host}" has an invalid port "${portStr}"`);
        }
        if (remoteProto !== undefined && remoteProto !== 'udp' && remoteProto !== 'tcp') {
          throw new UnsupportedDirectiveError('remote', `protocol ${remoteProto}`);
        }
        rawRemotes.push({ host, port, proto: remoteProto });
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
      case 'fragment':
        fragment = parseFragment(rest);
        break;
      case 'mssfix':
        // A bare `mssfix` means OpenVPN's default, which sing-box applies on its own.
        mss = rest.length > 0 ? parseMssfix(rest) : {};
        break;
      case 'comp-lzo':
        // Only `no` is mapped (compression framing, no compression); every other value
        // was ignored before client-certificate profiles were supported, and still is.
        if (arg === 'no') compressionLzo = 'no';
        break;
      case 'verify-x509-name':
        x509Name = parseX509Name(arg);
        break;
      case 'ns-cert-type':
        if (arg !== 'server') throw new UnsupportedDirectiveError('ns-cert-type', arg);
        nsCertType = 'server';
        break;
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

  if (rawRemotes.length === 0) {
    throw new Error('file: .ovpn is missing a `remote <host> <port>` directive');
  }
  const remotes: OvpnRemote[] = rawRemotes.map((r) => ({ host: r.host, port: r.port, proto: r.proto ?? proto }));
  const first = remotes[0];
  const servers = [
    ...new Set(remotes.filter((r) => r.port === first.port && r.proto === first.proto).map((r) => r.host)),
  ];
  if (!caLines) {
    throw new Error('file: .ovpn is missing an inline <ca> block');
  }
  if (Boolean(clientCertLines) !== Boolean(clientKeyLines)) {
    throw new UnsupportedDirectiveError(clientCertLines ? '<cert>' : '<key>', 'a client certificate needs both <cert> and <key>');
  }

  // `keyDirection` (0/1/bidirectional) only ever maps to 'client' here: sing-box's
  // control_wrap direction field has no other literal in contracts.ts, and every
  // real-world sample inlines tls-auth from the client's perspective. We still
  // parse it above (so an absent/garbled value doesn't silently pass through
  // the default branch as an unsupported directive) but don't branch on it.
  void keyDirection;

  return {
    remoteHost: first.host,
    remotePort: first.port,
    proto: first.proto,
    remotes,
    servers,
    cipher,
    auth,
    caLines,
    tlsAuthLines,
    tlsCryptLines,
    controlWrapDirection: tlsAuthLines || tlsCryptLines ? 'client' : undefined,
    needsAuthUserPass,
    tunMtu,
    ...(clientCertLines && clientKeyLines ? { clientCertLines, clientKeyLines } : {}),
    ...(fragment !== undefined ? { fragment } : {}),
    ...mss,
    ...(compressionLzo ? { compressionLzo } : {}),
    ...(x509Name ? { serverName: x509Name.name, serverNameType: x509Name.type } : {}),
    ...(nsCertType ? { nsCertType } : {}),
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
