import type { ExportFormat, PortBucket, PortCheck, PortRow } from '../../shared/contracts';
import { portBucket } from '../../shared/portBucket';

export interface ExportCreds {
  host: string;
  user: string;
  pass: string;
}

/** The one-proxy-per-line formats; `csv` is a table (see `exportCsv`). */
export type LineFormat = Exclude<ExportFormat, 'csv'>;

/** One proxy, formatted as one of the 4 v1 export formats (spec §4.2). Credentials are
 * omitted from `hostPort`/`hostPortUserPass` the way v1 did when no auth is set. */
export function formatProxy(format: LineFormat, port: number, c: ExportCreds): string {
  const hasAuth = Boolean(c.user);
  const u = encodeURIComponent(c.user);
  const p = encodeURIComponent(c.pass);
  switch (format) {
    case 'hostPortUserPass':
      return hasAuth ? `${c.host}:${port}:${c.user}:${c.pass}` : `${c.host}:${port}`;
    case 'socks5Url':
      return hasAuth ? `socks5://${u}:${p}@${c.host}:${port}` : `socks5://${c.host}:${port}`;
    case 'hostPort':
      return `${c.host}:${port}`;
    case 'curl':
      return `curl -x socks5h://${hasAuth ? `${u}:${p}@` : ''}${c.host}:${port} https://api.ipify.org`;
  }
}

export function exportLines(format: LineFormat, ports: number[], c: ExportCreds): string {
  return ports.map((port) => formatProxy(format, port, c)).join('\n');
}

/**
 * The renderer's Check results as main may trust them: only `{ ok: boolean, latencyMs?:
 * finite number >= 0 }` entries survive, anything else is dropped (they cross IPC).
 */
export function sanitizeChecks(raw: unknown): Record<string, PortCheck> {
  const out: Record<string, PortCheck> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const { ok, latencyMs } = value as Record<string, unknown>;
    if (typeof ok !== 'boolean') continue;
    const validMs = typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0;
    out[key] = validMs ? { ok, latencyMs: Math.round(latencyMs) } : { ok };
  }
  return out;
}

export const CSV_HEADER = ['host', 'port', 'username', 'password', 'location', 'provider', 'exit_ip', 'country', 'status', 'latency_ms'] as const;

/** One CSV field, quoted per RFC 4180 when it holds a comma, quote, CR or LF. */
export function csvField(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The CSV export (spec §4.2): a header row, then one row per port, CRLF line breaks.
 * `status` is the port's filter bucket and `latency_ms` its latest Check, else the
 * health poll's latency, else empty; `checks` are the renderer's current Check results.
 */
export function exportCsv(ports: readonly PortRow[], c: ExportCreds, checks: Readonly<Record<string, PortCheck>> = {}): string {
  const lines = [CSV_HEADER.join(',')];
  for (const p of ports) {
    const check = checks[p.key];
    const state = p.state;
    const status: PortBucket = portBucket(state, check);
    const polled = state.kind === 'online' ? state.latencyMs : undefined;
    // A failed check has no latency, and the poll's older figure would contradict it.
    const latency = check ? (check.ok ? (check.latencyMs ?? polled) : undefined) : polled;
    const fields = [
      c.host,
      p.proxyPort,
      c.user,
      c.pass,
      p.city,
      p.providerId,
      state.kind === 'online' ? state.exitIp : undefined,
      p.country,
      status,
      latency,
    ];
    lines.push(fields.map(csvField).join(','));
  }
  return lines.join('\r\n');
}
