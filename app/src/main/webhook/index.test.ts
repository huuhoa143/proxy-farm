import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortRow, RotateResult } from '../../shared/contracts';
import { generateBearer, MIN_BEARER_LENGTH, resolveRotateKey, startWebhook, type Webhook } from './index';

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

  async function start(
    rotate = vi.fn(async (): Promise<RotateResult> => ({ changed: true, from: '1.1.1.1', to: '2.2.2.2' })),
    resolveKey?: (key: string) => string,
  ) {
    webhook = await startWebhook({
      host: '127.0.0.1',
      port: 0,
      bearer: 'sekret-token-0123',
      hostAllowlist: ['127.0.0.1', 'proxyfarm.local'],
      rotate,
      resolveKey,
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

  it('accepts a port key (with its # URL-encoded) and maps a bare location key through resolveKey', async () => {
    const ports = [row('hma:jp-tok#3'), row('hma:jp-tok#2')];
    const { port, rotate } = await start(undefined, (k) => resolveRotateKey(k, ports));
    await call(port, { path: '/rotate/hma%3Ajp-tok%233', authorization: 'Bearer sekret-token-0123' });
    await call(port, { path: '/rotate/hma%3Ajp-tok', authorization: 'Bearer sekret-token-0123' });
    expect(rotate.mock.calls).toEqual([['hma:jp-tok#3'], ['hma:jp-tok#2']]);
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

function row(key: string, locationKey = key.split('#')[0]): PortRow {
  return { key, locationKey, providerId: 'hma', accountId: 'a', label: key, country: 'JP', city: 'Tokyo', proxyPort: 1, enabled: true, state: { kind: 'stopped' }, autoRotateMin: 0 };
}

describe('resolveRotateKey (spec §6.6 bare-location alias)', () => {
  it('a bare location key means that location\'s lowest-numbered port', () => {
    expect(resolveRotateKey('hma:jp-tok', [row('hma:jp-tok#4'), row('hma:jp-tok#2'), row('hma:vn#1')])).toBe('hma:jp-tok#2');
  });

  it('port keys and keys matching nothing pass through unchanged', () => {
    const ports = [row('hma:jp-tok#2')];
    expect(resolveRotateKey('hma:jp-tok#2', ports)).toBe('hma:jp-tok#2');
    expect(resolveRotateKey('hma:jp-tok#9', ports)).toBe('hma:jp-tok#9');
    expect(resolveRotateKey('hma:nowhere', ports)).toBe('hma:nowhere');
  });

  it("a retired bare location key follows the alias map to its new location's lowest port", () => {
    const ports = [row('zoogvpn:JP#3'), row('zoogvpn:JP#2')];
    expect(resolveRotateKey('zoogvpn:JP-JP3', ports, { 'zoogvpn:JP-JP3': 'zoogvpn:JP' })).toBe('zoogvpn:JP#2');
    // Retired twice: the chain is followed.
    expect(resolveRotateKey('zoogvpn:jp3', ports, { 'zoogvpn:jp3': 'zoogvpn:JP-JP3', 'zoogvpn:JP-JP3': 'zoogvpn:JP' })).toBe('zoogvpn:JP#2');
  });

  it('a live location wins over an alias, and a cycle or dead end passes the key through', () => {
    expect(resolveRotateKey('hma:a', [row('hma:a#1'), row('hma:b#1')], { 'hma:a': 'hma:b' })).toBe('hma:a#1');
    expect(resolveRotateKey('hma:a', [], { 'hma:a': 'hma:b', 'hma:b': 'hma:a' })).toBe('hma:a');
    expect(resolveRotateKey('hma:a', [], { 'hma:a': 'hma:gone' })).toBe('hma:a');
    expect(resolveRotateKey('constructor', [], {})).toBe('constructor'); // no prototype keys
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
