import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RotateResult } from '../../shared/contracts';

/**
 * Optional rotate webhook (spec §6.6), off by default: a separate `http` listener,
 * bound to `127.0.0.1` unless LAN sharing is also on (`0.0.0.0`). Only
 * `POST /rotate/<location-key>` is served. The bearer token is compared in constant
 * time, the `Host` header must be in an allowlist (anti DNS-rebinding), and no CORS
 * headers are ever sent.
 */
export interface WebhookOptions {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  bearer: string;
  hostAllowlist: string[];
  rotate(key: string): Promise<RotateResult>;
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

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function startWebhook(options: WebhookOptions): Promise<Webhook> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => send(res, 500, 'internal error'));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No CORS headers are ever sent, on any response (success or error).
    const hostHeader = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (!options.hostAllowlist.map((h) => h.toLowerCase()).includes(hostHeader)) {
      send(res, 403, 'forbidden host');
      return;
    }

    const url = req.url ?? '';
    const path = url.split('?')[0];
    const match = path.match(ROTATE_PATH_RE);

    if (req.method !== 'POST' || !match) {
      send(res, 405, 'method not allowed');
      return;
    }

    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${options.bearer}`;
    if (!options.bearer || !constantTimeEquals(auth, expected)) {
      send(res, 401, 'unauthorized');
      return;
    }

    const key = decodeURIComponent(match[1]);
    const result = await options.rotate(key);
    send(res, 200, JSON.stringify(result));
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
