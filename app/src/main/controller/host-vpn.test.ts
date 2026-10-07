import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostVpnMonitor, isDefaultRouteViaTunnel } from './host-vpn';

const ROUTE_VIA_IPSEC0 = `   route to: default
destination: default
       mask: default
    gateway: 10.8.0.1
  interface: ipsec0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
`;

const ROUTE_VIA_EN0 = `   route to: default
destination: default
       mask: default
    gateway: 192.168.2.253
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
`;

const ROUTE_VIA_UTUN4 = `   route to: default
destination: default
  interface: utun4
`;

// A "split" route (0.0.0.0/1 + 128.0.0.0/1) never touches the literal default route, so
// `route -n get 1.1.1.1` (not `get default`) is what reveals it: 1.1.1.1 falls under the
// first half, 0.0.0.0/1, which these VPN clients install pointing at the tunnel.
const ROUTE_1_1_1_1_VIA_SPLIT_TUN2 = `   route to: 1.1.1.1
destination: 0.0.0.0
       mask: 128.0.0.0
    gateway: 10.9.0.1
  interface: tun2
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>
`;

const ROUTE_VIA_PPP0 = `   route to: default
destination: default
  interface: ppp0
`;

describe('isDefaultRouteViaTunnel (spec §4.3 macOS detection)', () => {
  it('a default route via ipsec0 (HMA) is active', () => {
    expect(isDefaultRouteViaTunnel(ROUTE_VIA_IPSEC0)).toBe(true);
  });

  it('a default route via utunN (WireGuard-style) is active', () => {
    expect(isDefaultRouteViaTunnel(ROUTE_VIA_UTUN4)).toBe(true);
  });

  it('a split-route pair (0.0.0.0/1 + 128.0.0.0/1) via tunN is active', () => {
    expect(isDefaultRouteViaTunnel(ROUTE_1_1_1_1_VIA_SPLIT_TUN2)).toBe(true);
  });

  it('a default route via pppN (PPP-based client) is active', () => {
    expect(isDefaultRouteViaTunnel(ROUTE_VIA_PPP0)).toBe(true);
  });

  it('a default route via a normal interface (en0) is not active', () => {
    expect(isDefaultRouteViaTunnel(ROUTE_VIA_EN0)).toBe(false);
  });

  it('unparsable output is treated as inactive', () => {
    expect(isDefaultRouteViaTunnel('garbage, no interface line')).toBe(false);
  });
});

describe('createHostVpnMonitor', () => {
  it('isHostVpnActive on darwin reflects the injected route check', async () => {
    const monitor = createHostVpnMonitor({ platform: 'darwin', runDefaultRouteCheck: async () => ROUTE_VIA_IPSEC0 });
    expect(await monitor.isHostVpnActive()).toBe(true);
  });

  it('isHostVpnActive always returns false on win32 (§12: unverified TODO)', async () => {
    const monitor = createHostVpnMonitor({ platform: 'win32', runDefaultRouteCheck: async () => ROUTE_VIA_IPSEC0 });
    expect(await monitor.isHostVpnActive()).toBe(false);
  });

  it('returns false (not throw) when the route check itself fails', async () => {
    const monitor = createHostVpnMonitor({
      platform: 'darwin',
      runDefaultRouteCheck: async () => {
        throw new Error('route: command not found');
      },
    });
    await expect(monitor.isHostVpnActive()).resolves.toBe(false);
  });

  describe('polling', () => {
    let state = ROUTE_VIA_EN0;

    beforeEach(() => {
      vi.useFakeTimers();
      state = ROUTE_VIA_EN0;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls every 10s by default and emits only on a transition', async () => {
      const monitor = createHostVpnMonitor({ platform: 'darwin', runDefaultRouteCheck: async () => state });
      const seen: boolean[] = [];
      monitor.onChange((active) => seen.push(active));
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([false]); // initial poll establishes the baseline (inactive)

      state = ROUTE_VIA_IPSEC0;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen).toEqual([false, true]);

      // no further change while still active
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen).toEqual([false, true]);

      state = ROUTE_VIA_EN0;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen).toEqual([false, true, false]);

      monitor.stop();
    });

    it('never overlaps a poll that is still in flight (a slow check does not pile up)', async () => {
      let concurrentRunners = 0;
      let maxConcurrent = 0;
      let calls = 0;
      const monitor = createHostVpnMonitor({
        platform: 'darwin',
        pollMs: 1000,
        runDefaultRouteCheck: async () => {
          calls++;
          concurrentRunners++;
          maxConcurrent = Math.max(maxConcurrent, concurrentRunners);
          await new Promise((r) => setTimeout(r, 5000)); // slower than the 1s poll interval
          concurrentRunners--;
          return ROUTE_VIA_EN0;
        },
      });
      monitor.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maxConcurrent).toBe(1);
      expect(calls).toBeLessThan(10); // ticks that land while one is still in flight are skipped
      monitor.stop();
    });

    it('stop() halts polling', async () => {
      const monitor = createHostVpnMonitor({ platform: 'darwin', runDefaultRouteCheck: async () => state });
      const seen: boolean[] = [];
      monitor.onChange((active) => seen.push(active));
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.stop();
      seen.length = 0; // drop the initial baseline emission; we only care about post-stop
      state = ROUTE_VIA_IPSEC0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen).toEqual([]);
    });

    it('onChange unsubscribe stops future callbacks', async () => {
      const monitor = createHostVpnMonitor({ platform: 'darwin', runDefaultRouteCheck: async () => state });
      const seen: boolean[] = [];
      const unsubscribe = monitor.onChange((active) => seen.push(active));
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      unsubscribe();
      seen.length = 0; // drop the initial baseline emission; we only care about post-unsubscribe
      state = ROUTE_VIA_IPSEC0;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen).toEqual([]);
      monitor.stop();
    });
  });
});
