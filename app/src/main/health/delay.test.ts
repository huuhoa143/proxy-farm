import { describe, expect, it, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { delayProbe, FETCH_TIMEOUT_MS, PROBE_TIMEOUT_MS } from './delay';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startServer(handler: Handler): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('delayProbe', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('hits GET /proxies/<tag>/delay with the right query and bearer header, maps 200 -> {code:200, ms}', async () => {
    let seenPath = '';
    let seenAuth = '';
    const { port, close } = await startServer((req, res) => {
      seenPath = req.url ?? '';
      seenAuth = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ delay: 123 }));
    });
    cleanup = close;

    const result = await delayProbe(port, 'sekrit', 'ep');

    expect(seenPath).toBe('/proxies/ep/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000');
    expect(seenAuth).toBe('Bearer sekrit');
    expect(result).toEqual({ code: 200, ms: 123 });
  });

  it('maps HTTP 503 to {code:503}', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    cleanup = close;
    await expect(delayProbe(port, 'x', 'ep')).resolves.toEqual({ code: 503 });
  });

  it('maps HTTP 504 to {code:504}', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(504);
      res.end();
    });
    cleanup = close;
    await expect(delayProbe(port, 'x', 'ep')).resolves.toEqual({ code: 504 });
  });

  it('maps an unexpected status to {code:"error", message}', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(418);
      res.end();
    });
    cleanup = close;
    const result = await delayProbe(port, 'x', 'ep');
    expect(result.code).toBe('error');
    expect((result as { message: string }).message).toMatch(/418/);
  });

  it('maps a connection failure (nothing listening) to {code:"error", message}', async () => {
    const result = await delayProbe(59999, 'x', 'ep');
    expect(result.code).toBe('error');
    expect(typeof (result as { message: string }).message).toBe('string');
  });

  it('maps a 200 with a malformed body to {code:"error", message}', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json');
    });
    cleanup = close;
    const result = await delayProbe(port, 'x', 'ep');
    expect(result.code).toBe('error');
  });

  it('aborts and maps to {code:"error"} if the server never responds at all (client-side hard timeout)', async () => {
    const { port, close } = await startServer(() => {
      // never calls res.end() — simulates a wedged clash_api server
    });
    cleanup = close;
    const result = await delayProbe(port, 'x', 'ep', { fetchTimeoutMs: 50 });
    expect(result.code).toBe('error');
    expect((result as { message: string }).message.toLowerCase()).toMatch(/abort|timeout|did not answer/);
  });

  describe('hard timeout (fake timers)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('settles a fetch that never resolves (and ignores its signal) as {code:"error", timedOut:true} after 8 s', async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetchFn = vi.fn((_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }) as unknown as typeof fetch;

      let settled: Awaited<ReturnType<typeof delayProbe>> | undefined;
      void delayProbe(1, 'x', 'ep', { fetchFn }).then((r) => {
        settled = r;
      });
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 2_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ code: 'error', timedOut: true });
      expect(signal?.aborted).toBe(true);
      expect(FETCH_TIMEOUT_MS).toBeGreaterThan(PROBE_TIMEOUT_MS);
    });

    it('a body that never arrives also hits the hard timeout', async () => {
      vi.useFakeTimers();
      const fetchFn = vi.fn(async () => ({ status: 200, json: () => new Promise(() => undefined) }) as unknown as Response) as unknown as typeof fetch;
      const pending = delayProbe(1, 'x', 'ep', { fetchFn, fetchTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({ code: 'error', timedOut: true });
    });

    it('a refused connection is an error but not a timeout', async () => {
      const fetchFn = vi.fn(async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      }) as unknown as typeof fetch;
      const result = await delayProbe(1, 'x', 'ep', { fetchFn });
      expect(result.code).toBe('error');
      expect((result as { timedOut?: boolean }).timedOut).toBeUndefined();
    });
  });
});
