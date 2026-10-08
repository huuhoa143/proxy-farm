import type { ExportFormat } from '../../shared/contracts';

export interface ExportCreds {
  host: string;
  user: string;
  pass: string;
}

/** One proxy, formatted as one of the 4 v1 export formats (spec §4.2). Credentials are
 * omitted from `hostPort`/`hostPortUserPass` the way v1 did when no auth is set. */
export function formatProxy(format: ExportFormat, port: number, c: ExportCreds): string {
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

export function exportLines(format: ExportFormat, ports: number[], c: ExportCreds): string {
  return ports.map((port) => formatProxy(format, port, c)).join('\n');
}
