import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RotateResult } from '../../shared/contracts';
import { generateBearer, MIN_BEARER_LENGTH, startWebhook, type Webhook } from './index';

function call(
  port: number,
  opts: { method?: string; path?: string; host?: string; authorization?: string },
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/rotate/hma:jp-tok',
        headers: {
          host: opts.host ?? '127.0.0.1',
          ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers as any }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('rotate webhook (spec §6.6)', () => {
  let webhook: Webhook | undefined;

  afterEach(async () => {
    await webhook?.close();
    webhook = undefined;
  });

  async function start(rotate = vi.fn(async (): Promise<RotateResult> => ({ changed: true, from: '1.1.1.1', to: '2.2.2.2' }))) {
    webhook = await startWebhook({
      host: '127.0.0.1',
      port: 0,
      bearer: 'sekret-token-0123',
      hostAllowlist: ['127.0.0.1', 'proxyfarm.local'],
      rotate,
    });
    const port = (webhook.server.address() as AddressInfo).port;
    return { port, rotate };
  }

  it('GET to a valid rotate path is rejected with 405', async () => {
    const { port } = await start();
    const res = await call(port, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('an unknown (non-rotate) path is rejected with 404, for any method', async () => {
    const { port, rotate } = await start();
    const getRes = await call(port, { method: 'GET', path: '/status' });
    expect(getRes.status).toBe(404);
    const postRes = await call(port, { path: '/status', authorization: 'Bearer sekret-token-0123' });
    expect(postRes.status).toBe(404);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('a missing/bad bearer is rejected with 401', async () => {
    const { port, rotate } = await start();
    const res = await call(port, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
    expect(rotate).not.toHaveBeenCalled();

    const res2 = await call(port, {}); // no Authorization header at all
    expect(res2.status).toBe(401);
  });

  it('a Host header outside the allowlist is rejected with 403, even with a correct bearer', async () => {
    const { port, rotate } = await start();
    const res = await call(port, { host: 'evil.example.com', authorization: 'Bearer sekret-token-0123' });
    expect(res.status).toBe(403);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('a well-formed request calls rotate with the decoded key and returns its result as JSON', async () => {
    const { port, rotate } = await start();
    const res = await call(port, { path: '/rotate/hma%3Ajp-tok', authorization: 'Bearer sekret-token-0123' });
    expect(res.status).toBe(200);
    expect(rotate).toHaveBeenCalledWith('hma:jp-tok');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({ changed: true, from: '1.1.1.1', to: '2.2.2.2' });
  });

  it('never sends CORS headers, success or failure', async () => {
    const { port } = await start();
    const ok = await call(port, { authorization: 'Bearer sekret-token-0123' });
    const bad = await call(port, { authorization: 'Bearer nope' });
    for (const res of [ok, bad]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
    }
  });

  it('an allowlisted Host with a port suffix is still accepted (host header compared without :port)', async () => {
    const { port, rotate } = await start();
    const res = await call(port, { host: `127.0.0.1:${port}`, authorization: 'Bearer sekret-token-0123' });
    expect(res.status).toBe(200);
    expect(rotate).toHaveBeenCalled();
  });

  it('an IPv6 Host header is parsed correctly (brackets stripped, not split on every colon)', async () => {
    webhook = await startWebhook({
      host: '127.0.0.1',
      port: 0,
      bearer: 'sekret-token-0123',
      hostAllowlist: ['::1'],
      rotate: vi.fn(async (): Promise<RotateResult> => ({ changed: false, noteKey: 'no-server' })),
    });
    const port = (webhook.server.address() as AddressInfo).port;
    const res = await call(port, { host: `[::1]:${port}`, authorization: 'Bearer sekret-token-0123' });
    expect(res.status).toBe(200);
  });
});

describe('generateBearer / MIN_BEARER_LENGTH', () => {
  it('generates a bearer meeting the minimum length, different each time', () => {
    const a = generateBearer();
    const b = generateBearer();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_BEARER_LENGTH);
  });
});
