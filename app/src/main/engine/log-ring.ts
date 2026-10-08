// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

const SENSITIVE_KEYS = ['username', 'password', 'private_key', 'pre_shared_key', 'secret', 'udid'];
const KEY_GROUP = SENSITIVE_KEYS.join('|');

/**
 * Matches a sensitive key (optionally quoted, e.g. inside JSON) followed by
 * `:`/`=` and a value — quoted (`"..."`, JSON or shell-quoted) or a bare
 * token. One pattern covers `"password":"hunter2"`, `password: hunter2`, and
 * `password=hunter2` alike; the replacer re-quotes the redaction only when
 * the original value was quoted, to keep JSON-shaped lines JSON-shaped.
 */
const SENSITIVE_FIELD_RE = new RegExp(`("?\\b(?:${KEY_GROUP})\\b"?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|\\S+)`, 'gi');

/** `user:pass@host` URL userinfo (e.g. inside a `socks5h://` URL in a log line). */
const USERINFO_RE = /\b[A-Za-z0-9][\w.+-]*:[^@\s/]+@/g;

/**
 * sing-box's `inbound/mixed[<tag>]:` connection logs embed the authenticated
 * proxy username in brackets, e.g. `inbound/mixed[in]: [alice] inbound
 * connection to 1.2.3.4:443` (spec §6.1.7) — not covered by the
 * `username=`/`username:` patterns above since there's no key name at all here.
 */
const MIXED_INBOUND_USER_RE = /(inbound\/mixed\[[^\]]*\]:\s*)\[[^\]]*\]/g;

/** Any run of 64+ hex chars (a token/key), with lookaround so a 65th+ hex char doesn't create a false boundary. */
const HEX_RUN_RE = /(?<![0-9a-f])[0-9a-f]{64,}(?![0-9a-f])/gi;

/**
 * The HMA device id (udid) used as the OpenVPN username (spec §5.1), shaped
 * `U1.<uuid>.hmaNNN`. It is in the threat model but isn't a 64-hex run and may
 * appear bare in a sing-box line with no `username=` key, so match the shape
 * directly. (The matching `username=`/`username:` and the 64-hex password are
 * already covered above.)
 */
const UDID_RE = /\bU\d+\.[0-9a-f-]{16,}\.hma\d+\b/gi;

/**
 * Redacts a log line before it is ever buffered (spec §6.1.7): strips ANSI
 * escapes first (so the patterns below see plain text), then the bracketed
 * proxy username in `inbound/mixed[tag]: [user] ...` connection logs, then
 * sensitive JSON/kv fields (`username`, `password`, `private_key`,
 * `pre_shared_key`, `secret`), then `user:pass@` URL userinfo, then any bare
 * 64+ hex-char run.
 */
export function redactLine(line: string): string {
  let out = line.replace(ANSI_RE, '');
  out = out.replace(MIXED_INBOUND_USER_RE, '$1[***]');
  out = out.replace(USERINFO_RE, '[redacted]@');
  out = out.replace(SENSITIVE_FIELD_RE, (_match, prefix: string, value: string) =>
    value.startsWith('"') ? `${prefix}"[redacted]"` : `${prefix}[redacted]`,
  );
  out = out.replace(UDID_RE, '[redacted]');
  out = out.replace(HEX_RUN_RE, '[redacted]');
  return out;
}

/**
 * Fixed-size ring buffer of redacted log lines for one sing-box process.
 * Lines are redacted on push, so the raw secret never exists inside the
 * buffer even transiently.
 */
export class LogRing {
  private readonly capacity: number;
  private buffer: string[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`LogRing: capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  push(rawLine: string): void {
    this.buffer.push(redactLine(rawLine));
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }

  get lines(): string[] {
    return [...this.buffer];
  }
}
