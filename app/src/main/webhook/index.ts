import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { splitPortKey, type PortRow, type RotateResult } from '../../shared/contracts';

/**
 * Optional rotate webhook (spec §6.6), off by default: a separate `http` listener,
 * bound to `127.0.0.1` unless LAN sharing is also on (`0.0.0.0`). Only
 * `POST /rotate/<port-key>` is served (the `#` of a port key URL-encoded as `%23`); a
 * bare location key is an alias for that location's first port (see `resolveKey`). The
 * bearer token is compared in constant time, the `Host` header must be in an allowlist
 * (anti DNS-rebinding), and no CORS headers are ever sent.
 */
export interface WebhookOptions {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  bearer: string;
  hostAllowlist: string[];
  rotate(key: string): Promise<RotateResult>;
  /** Maps the requested key to a port key before `rotate` (e.g. `resolveRotateKey`
   * over the current rows). @default identity */
  resolveKey?(key: string): string;
}

/** Longest alias chain followed (a location retired twice), and a guard against a cycle. */
const MAX_ALIAS_HOPS = 4;

/**
 * spec §6.6: a bare location key (pre-rev-3 scripts) means that location's
 * lowest-numbered port. A bare key of a location that a provider has since retired is
 * followed through `aliases` (old location key → new one, written by the boot-time
 * re-attach) to where its ports moved. Port keys, and keys matching nothing, pass
 * through unchanged (the latter then rotate nothing and report `no-server`).
 */
export function resolveRotateKey(key: string, ports: PortRow[], aliases: Record<string, string> = {}): string {
  if (ports.some((p) => p.key === key)) return key;
  let location = key;
  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
    let best: { key: string; n: number } | undefined;
    for (const p of ports) {
      const parts = splitPortKey(p.key);
      if (p.locationKey !== location || !parts) continue;
      if (!best || parts.n < best.n) best = { key: p.key, n: parts.n };
    }
    if (best) return best.key;
    const next = Object.prototype.hasOwnProperty.call(aliases, location) ? aliases[location] : undefined;
    if (next === undefined) break;
    location = next;
  }
  return key;
}

export interface Webhook {
  close(): Promise<void>;
  readonly server: Server;
}

const ROTATE_PATH_RE = /^\/rotate\/([^/?#]+)\/?$/;

/** Constant-time string compare, independent of the inputs' lengths. Two HMACs over
 * each candidate with the same random key have fixed, equal length, so a mismatched
 * length never leaks via `timingSafeEqual`'s own length check. */
function constantTimeEquals(a: string, b: string): boolean {
  const key = randomBytes(32);
  const macA = createHmac('sha256', key).update(a).digest();
  const macB = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(macA, macB);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Strips the `:port` suffix from a `Host` header, correctly for an IPv6 literal
 * (`[::1]:3000` -> `::1`) as well as a plain hostname/IPv4 (`example.com:3000` ->
 * `example.com`). A bare IPv6 literal with no brackets (no port possible) is passed
 * through unchanged. */
function hostWithoutPort(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(1, end);
  }
  return hostHeader.split(':')[0];
}

/** A bearer with real entropy, for auto-generating one when the webhook is enabled
 * with an empty bearer (reviewer minor) — also exported for `controller/settings.ts`. */
export function generateBearer(): string {
  return randomBytes(24).toString('base64url');
}

export const MIN_BEARER_LENGTH = 16;

export function startWebhook(options: WebhookOptions): Promise<Webhook> {
  // Enforced here too (reviewer item 10), not just by the caller (`controller/settings.ts`'s
  // `applySettingsPatch`): a short bearer is a brute-forceable auth bypass on a listener
  // that's reachable from the LAN whenever `lanSharing` is also on, so this must hold
  // regardless of which caller starts the webhook.
  if (options.bearer.length < MIN_BEARER_LENGTH) {
    return Promise.reject(new Error(`webhook bearer must be at least ${MIN_BEARER_LENGTH} characters`));
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => send(res, 500, 'internal error'));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No CORS headers are ever sent, on any response (success or error).
    const hostHeader = hostWithoutPort(req.headers.host ?? '').toLowerCase();
    if (!options.hostAllowlist.map((h) => h.toLowerCase()).includes(hostHeader)) {
      send(res, 403, 'forbidden host');
      return;
    }

    const url = req.url ?? '';
    const path = url.split('?')[0];
    const match = path.match(ROTATE_PATH_RE);

    if (!match) {
      send(res, 404, 'not found');
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, 'method not allowed');
      return;
    }

    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${options.bearer}`;
    if (!options.bearer || !constantTimeEquals(auth, expected)) {
      send(res, 401, 'unauthorized');
      return;
    }

    const requested = decodeURIComponent(match[1]);
    const key = options.resolveKey ? options.resolveKey(requested) : requested;
    const result = await options.rotate(key);
    send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve({
        server,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
