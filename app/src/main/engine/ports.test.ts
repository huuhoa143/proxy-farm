import { describe, expect, it, afterEach } from 'vitest';
import net from 'node:net';
import { isPortFree, allocatePort } from './ports';

function listenOn(host: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('isPortFree', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it('is true for an unused high port', async () => {
    // Use an ephemeral free port found by the OS itself to avoid flakiness.
    const probe = await listenOn('127.0.0.1', 0);
    const port = (probe.address() as net.AddressInfo).port;
    await close(probe);
    await expect(isPortFree(port)).resolves.toBe(true);
  });

  it('is false when something listens on 127.0.0.1', async () => {
    const probe = await listenOn('127.0.0.1', 0);
    const port = (probe.address() as net.AddressInfo).port;
    servers.push(probe);
    await expect(isPortFree(port)).resolves.toBe(false);
  });

  it('is false when something listens on 0.0.0.0 (the wildcard trap, spec §6.2)', async () => {
    const probe = await listenOn('0.0.0.0', 0);
    const port = (probe.address() as net.AddressInfo).port;
    servers.push(probe);
    // A foreign 0.0.0.0 listener lets a 127.0.0.1 bind succeed silently —
    // isPortFree must test-bind BOTH hosts and catch this.
    await expect(isPortFree(port)).resolves.toBe(false);
  });
});

describe('allocatePort', () => {
  it('returns the preferred port when free and untaken', async () => {
    const probe = await listenOn('127.0.0.1', 0);
    const port = (probe.address() as net.AddressInfo).port;
    await close(probe);
    await expect(allocatePort({ preferred: port })).resolves.toBe(port);
  });

  it('skips a preferred port that is occupied', async () => {
    const probe = await listenOn('127.0.0.1', 0);
    const occupied = (probe.address() as net.AddressInfo).port;
    try {
      const got = await allocatePort({ preferred: occupied, base: occupied });
      expect(got).not.toBe(occupied);
    } finally {
      await close(probe);
    }
  });

  it('skips ports in the `taken` set even if nothing is listening', async () => {
    const base = 31000 + Math.floor(Math.random() * 1000);
    const taken = new Set([base, base + 1]);
    const got = await allocatePort({ base, taken });
    expect(taken.has(got)).toBe(false);
    expect(got).toBeGreaterThanOrEqual(base);
  });

  it('rejects a wildcard-occupied port and moves on', async () => {
    const base = 32000 + Math.floor(Math.random() * 1000);
    const wildcard = await listenOn('0.0.0.0', base);
    try {
      const got = await allocatePort({ preferred: base, base });
      expect(got).not.toBe(base);
    } finally {
      await close(wildcard);
    }
  });
});
