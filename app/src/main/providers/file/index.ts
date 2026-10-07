/**
 * File provider — a dropped `.ovpn` or `.conf` becomes an endpoint
 * (spec §5.4). `check()` parses and validates the file (format only, no
 * network), `targets()` exposes its one location, and `bind()` re-parses
 * the raw content from the secrets store (never a path on disk — "imported
 * files are kept in the encrypted secrets store, not as plain files") to
 * build the endpoint.
 */
import type { Account, AccountSecret, CheckResult, Provider, Target } from '../types';
import { UnsupportedDirectiveError } from './errors';
import { parseOvpn } from './ovpn-parser';
import { parseWireguardConf } from './wg-parser';
import { buildOvpnEndpoint, buildWireguardEndpoint } from './endpoint-builder';

type Format = 'openvpn' | 'wireguard';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function createFileProvider(): Provider {
  return {
    id: 'file',

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const name = input.name ?? '';
      const content = input.content ?? '';
      const ext = extensionOf(name);

      try {
        if (ext === 'ovpn') {
          const parsed = parseOvpn(content);
          if (parsed.needsAuthUserPass && (!input.username || !input.password)) {
            return { ok: false, reasonKey: 'file.check.needsCredentials' };
          }
          const meta: Record<string, string> = {
            format: 'openvpn' satisfies Format,
            host: parsed.remoteHost,
            port: String(parsed.remotePort),
          };
          const secret: AccountSecret = {
            kind: 'file',
            content,
            username: input.username,
            password: input.password,
          };
          return { ok: true, label: `${parsed.remoteHost}:${parsed.remotePort}`, secret, meta };
        }

        if (ext === 'conf') {
          const parsed = parseWireguardConf(content);
          const meta: Record<string, string> = {
            format: 'wireguard' satisfies Format,
            host: parsed.endpointHost,
            port: String(parsed.endpointPort),
          };
          const secret: AccountSecret = { kind: 'file', content };
          return { ok: true, label: `${parsed.endpointHost}:${parsed.endpointPort}`, secret, meta };
        }

        return { ok: false, reasonKey: 'file.check.unknownExtension' };
      } catch (err) {
        if (err instanceof UnsupportedDirectiveError) {
          return { ok: false, reasonKey: err.reasonKey, label: err.directive };
        }
        return { ok: false, reasonKey: 'file.check.parseError', label: (err as Error).message };
      }
    },

    async targets(account: Account): Promise<Target[]> {
      const host = account.meta.host;
      const port = account.meta.port;
      if (!host) return [];
      return [
        {
          key: `file:${account.id}`,
          providerId: 'file',
          country: account.meta.country ?? '??',
          city: account.meta.city ?? '',
          label: `${host}:${port}`,
          servers: [host],
        },
      ];
    },

    bind(_target: Target, serverIp: string, account: Account, secret: AccountSecret) {
      if (secret.kind !== 'file') {
        throw new Error('file: bind() requires a file secret');
      }
      const format = account.meta.format as Format | undefined;
      if (format === 'openvpn') {
        const parsed = parseOvpn(secret.content);
        const creds = secret.username && secret.password ? { username: secret.username, password: secret.password } : undefined;
        return buildOvpnEndpoint(parsed, serverIp, creds);
      }
      if (format === 'wireguard') {
        const parsed = parseWireguardConf(secret.content);
        return buildWireguardEndpoint(parsed, serverIp);
      }
      throw new Error(`file: unknown account.meta.format "${String(format)}"`);
    },
  };
}

export const fileProvider = createFileProvider();
