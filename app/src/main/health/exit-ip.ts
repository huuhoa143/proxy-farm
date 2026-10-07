import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ExitIpResult } from '../../shared/contracts';

interface EchoEndpoint {
  name: string;
  url: string;
  parse: (body: string) => { ip?: string; country?: string };
}

/**
 * Fallback chain of https IP-echo services (spec §6.4). `api.ipify.org` is
 * tried first (fast, minimal, no country) — if it's the one that succeeds,
 * `probeExitIp` still needs a country, so it keeps falling through the chain
 * until one response carries both `ip` and `country`, or the chain is
 * exhausted (in which case the per-IP geo cache is consulted).
 */
const ENDPOINTS: EchoEndpoint[] = [
  {
    name: 'api.ipify.org',
    url: 'https://api.ipify.org?format=json',
    parse: (body) => ({ ip: (JSON.parse(body) as { ip?: string }).ip }),
  },
  {
    name: 'ifconfig.co',
    url: 'https://ifconfig.co/json',
    parse: (body) => {
      const j = JSON.parse(body) as { ip?: string; country_iso?: string; country?: string };
      return { ip: j.ip, country: j.country_iso ?? j.country };
    },
  },
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    parse: (body) => {
      const j = JSON.parse(body) as { ip?: string; country?: string };
      return { ip: j.ip, country: j.country };
    },
  },
];

export type FetchViaProxy = (url: string) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Default transport: a plain `https.get` routed through sing-box's SOCKS5
 * mixed inbound via `socks-proxy-agent` (chosen because Node's global
 * `fetch`/undici has no SOCKS dialer; `socks-proxy-agent` wraps the `socks`
 * client as a standard `http(s).Agent`, which `https.get` already accepts).
 */
function defaultFetchViaProxy(proxyPort: number): FetchViaProxy {
  // SocksProxyAgent extends `agent-base`'s Agent, which is structurally
  // compatible at runtime with node:https's Agent (that's the whole point of
  // the package) but not identical in its .d.ts, hence the cast.
  const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${proxyPort}`) as unknown as https.Agent;
  return (url: string) =>
    new Promise<string>((resolve, reject) => {
      const req = https.get(url, { agent, timeout: DEFAULT_TIMEOUT_MS }, (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`probeExitIp: timed out fetching ${url}`)));
      req.on('error', reject);
    });
}

export interface ProbeExitIpOptions {
  /** Injectable transport, so tests can hit a local mock HTTP server instead of a real SOCKS5 proxy + the internet. */
  fetchViaProxy?: FetchViaProxy;
  /** Per-IP geo cache. @default a module-level Map shared across calls in this process. */
  geoCache?: Map<string, string>;
}

const defaultGeoCache = new Map<string, string>();

/**
 * Resolves the exit IP and country reached through the local SOCKS5 proxy at
 * `127.0.0.1:proxyPort` (spec §6.4), trying each IP-echo service in turn
 * until one yields an IP, and (if needed) continuing until one also yields a
 * country — falling back to a cached country for that IP if the whole chain
 * never provides one. Throws if no endpoint ever yields an IP at all.
 */
export async function probeExitIp(proxyPort: number, opts: ProbeExitIpOptions = {}): Promise<ExitIpResult> {
  const fetchViaProxy = opts.fetchViaProxy ?? defaultFetchViaProxy(proxyPort);
  const geoCache = opts.geoCache ?? defaultGeoCache;

  let ip: string | undefined;
  let country: string | undefined;
  const errors: string[] = [];

  for (const endpoint of ENDPOINTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const body = await fetchViaProxy(endpoint.url);
      const parsed = endpoint.parse(body);
      if (parsed.ip && !ip) ip = parsed.ip;
      if (parsed.country) {
        country = parsed.country;
        break; // have both ip and country — done
      }
    } catch (err) {
      errors.push(`${endpoint.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!ip) {
    throw new Error(`probeExitIp: every IP-echo endpoint failed: ${errors.join('; ') || '(no endpoints attempted)'}`);
  }

  if (country) {
    geoCache.set(ip, country);
  } else {
    country = geoCache.get(ip) ?? 'unknown';
  }

  return { ip, country };
}
