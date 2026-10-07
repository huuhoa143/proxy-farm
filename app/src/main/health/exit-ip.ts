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
 * until one response carries both `ip` and a validly-formatted country, or
 * the chain is exhausted (in which case the per-IP geo cache is consulted).
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

/** `Target.country`/`ExitIpResult.country` is ISO-3166 alpha-2, upper case — anything else (a full name, lower case, etc.) is rejected and the chain keeps going. */
export function isValidCountryCode(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
}

export type FetchViaProxy = (url: string) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 8000;

/** Builds the `socks5h://[user:pass@]127.0.0.1:port` URL used for the default transport's SocksProxyAgent. Exported for tests. */
export function buildSocksProxyUrl(proxyPort: number, auth?: { username: string; password: string }): string {
  const userinfo = auth ? `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@` : '';
  return `socks5h://${userinfo}127.0.0.1:${proxyPort}`;
}

/**
 * Default transport: a plain `https.get` routed through sing-box's SOCKS5
 * mixed inbound via `socks-proxy-agent` (chosen because Node's global
 * `fetch`/undici has no SOCKS dialer; `socks-proxy-agent` wraps the `socks`
 * client as a standard `http(s).Agent`, which `https.get` already accepts).
 * `auth` is the mixed inbound's proxy username/password, when LAN sharing
 * (or any configured proxy auth) requires it.
 */
function defaultFetchViaProxy(proxyPort: number, auth?: { username: string; password: string }): FetchViaProxy {
  // SocksProxyAgent extends `agent-base`'s Agent, which is structurally
  // compatible at runtime with node:https's Agent (that's the whole point of
  // the package) but not identical in its .d.ts, hence the cast.
  const agent = new SocksProxyAgent(buildSocksProxyUrl(proxyPort, auth)) as unknown as https.Agent;
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
  /** SOCKS5 proxy auth (the mixed inbound's username/password), if the port requires it. Only used by the default transport. */
  auth?: { username: string; password: string };
}

const defaultGeoCache = new Map<string, string>();

/**
 * Resolves the exit IP and country reached through the local SOCKS5 proxy at
 * `127.0.0.1:proxyPort` (spec §6.4), trying each IP-echo service in turn.
 * As soon as an endpoint yields an IP, the geo cache is checked immediately
 * for that IP — a hit short-circuits the rest of the chain (no need to pay
 * for ifconfig.co/ipinfo.io just to re-derive a country we already know).
 * On a cache miss, the chain keeps going until one response yields a validly
 * formatted (upper-case ISO-3166 alpha-2) country; an invalid country is
 * treated as absent and the chain moves on to the next source. If the whole
 * chain is exhausted without ever producing one, the cache is consulted
 * (one last time) before falling back to `'unknown'`. Throws if no endpoint
 * ever yields an IP at all.
 */
export async function probeExitIp(proxyPort: number, opts: ProbeExitIpOptions = {}): Promise<ExitIpResult> {
  const fetchViaProxy = opts.fetchViaProxy ?? defaultFetchViaProxy(proxyPort, opts.auth);
  const geoCache = opts.geoCache ?? defaultGeoCache;

  let ip: string | undefined;
  let country: string | undefined;
  let countryIsFresh = false;
  const errors: string[] = [];

  for (const endpoint of ENDPOINTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const body = await fetchViaProxy(endpoint.url);
      const parsed = endpoint.parse(body);

      if (parsed.ip && !ip) {
        ip = parsed.ip;
        const cached = geoCache.get(ip);
        if (cached) {
          country = cached;
          break; // learned the ip and its country is already cached — no need to call more geo sources
        }
      }

      if (isValidCountryCode(parsed.country)) {
        country = parsed.country;
        countryIsFresh = true;
        break; // have both ip and a validly-formatted country — done
      }
      // else: no country yet (or an invalid format, e.g. a full name) — keep walking the chain
    } catch (err) {
      errors.push(`${endpoint.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!ip) {
    throw new Error(`probeExitIp: every IP-echo endpoint failed: ${errors.join('; ') || '(no endpoints attempted)'}`);
  }

  if (country && countryIsFresh) {
    geoCache.set(ip, country);
  } else if (!country) {
    country = geoCache.get(ip) ?? 'unknown';
  }

  return { ip, country };
}
