const CREDENTIAL_FIELD_RE = /(\b(?:username|password)\s*=\s*)(?:"[^"]*"|\S+)/gi;
const HEX64_TOKEN_RE = /\b[0-9a-f]{64}\b/gi;

/**
 * Redacts `username=`/`password=` values (quoted or bare) and any 64-hex-char
 * token from a log line, before it is ever buffered (spec §6.1.7).
 */
export function redactLine(line: string): string {
  return line.replace(CREDENTIAL_FIELD_RE, '$1[redacted]').replace(HEX64_TOKEN_RE, '[redacted]');
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
