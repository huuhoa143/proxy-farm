import { ENDPOINT_TAG, type RenderInput } from '../../shared/contracts';

const INBOUND_TAG = 'in';
const DNS_SERVER_TAG = 'dns-ep';

/**
 * Renders the full sing-box JSON config for one port (spec §6.1). CA/keys
 * are inlined verbatim from the endpoint spec — never written to disk, never
 * referenced by path. The result is piped to `sing-box run -c stdin` by the
 * Supervisor, never saved.
 */
export function renderConfig(input: RenderInput): string {
  const { endpoint, listen, clash } = input;

  if (listen.host === '0.0.0.0' && !listen.proxyAuth) {
    throw new Error('renderConfig: listen.proxyAuth is required when listen.host is "0.0.0.0" (LAN sharing requires proxy auth, spec §6.1.3)');
  }

  const inbound: Record<string, unknown> = {
    type: 'mixed',
    tag: INBOUND_TAG,
    listen: listen.host,
    listen_port: listen.port,
  };
  if (listen.proxyAuth) {
    inbound.users = [{ username: listen.proxyAuth.username, password: listen.proxyAuth.password }];
  }

  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [{ type: 'https', server: '1.1.1.1', tag: DNS_SERVER_TAG, detour: ENDPOINT_TAG }],
      final: DNS_SERVER_TAG,
      strategy: 'ipv4_only',
    },
    endpoints: [{ ...endpoint, tag: ENDPOINT_TAG, system: false }],
    inbounds: [inbound],
    outbounds: [{ type: 'block', tag: 'block' }],
    route: {
      rules: [{ inbound: [INBOUND_TAG], outbound: ENDPOINT_TAG }],
      final: 'block',
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${clash.port}`,
        secret: clash.secret,
      },
    },
  };

  return JSON.stringify(config);
}
