import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createRealExitIpProber, createRealPortAllocator } from './real-bindings';

describe('createRealPortAllocator', () => {
  it('allocates a free port honouring `taken`', async () => {
    const allocator = createRealPortAllocator();
    const port = await allocator.allocate({ base: 48000, taken: new Set([48000, 48001]) });
    expect(port).toBeGreaterThanOrEqual(48002);
  });

  it('prefers the preferred port when it is free and not taken', async () => {
    const allocator = createRealPortAllocator();
    const port = await allocator.allocate({ preferred: 48100 });
    expect(port).toBe(48100);
  });

  it('allocateAux scans from its own base range, independent of the main allocate base', async () => {
    const allocator = createRealPortAllocator();
    const aux = await allocator.allocateAux();
    expect(aux).toBeGreaterThanOrEqual(40000);
  });

  it('skips a port actually bound by something else, even if not in `taken`', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(48200, '127.0.0.1', resolve);
    });
    try {
      const allocator = createRealPortAllocator();
      const port = await allocator.allocate({ preferred: 48200, base: 48200 });
      expect(port).not.toBe(48200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('release() is a harmless no-op', () => {
    expect(() => createRealPortAllocator().release(12345)).not.toThrow();
  });
});

describe('createRealExitIpProber', () => {
  it('wraps probeExitIp, passing auth through under the {auth} shape it expects', async () => {
    const prober = createRealExitIpProber();
    // No real SOCKS proxy is running in a unit test; just confirm it reaches the real
    // probeExitIp function (which will fail fast on connection refused) rather than
    // throwing from a shape mismatch before ever getting there.
    await expect(prober.probe(1, { username: 'u', password: 'p' })).rejects.toThrow(/probeExitIp/);
  });
});
