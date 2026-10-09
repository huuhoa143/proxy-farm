import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostVpnMonitor, hasVpnNamedAdapter, isDefaultRouteViaTunnel, isWindowsRouteViaVpn, labelAdapters, type WindowsRouteSnapshot } from './host-vpn';

const ROUTE_VIA_IPSEC0 = `   route to: default
destination: default
       mask: default
    gateway: 10.8.0.1
  interface: ipsec0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
`;

// `route print -4` recorded on Windows 10 with HMA installed but disconnected (its Wintun
// adapter is down, so none of its routes are active).
const ROUTE_PRINT_IDLE = `===========================================================================
Interface List
 16...........................HMA VPN Wintun Adapter
  4...d8 5e d3 d4 7e 22 ......Intel(R) Ethernet Controller (3) I225-V
  1...........................Software Loopback Interface 1
===========================================================================

IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.113     35
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331
      192.168.1.0    255.255.255.0         On-link     192.168.1.113    291
    192.168.1.113  255.255.255.255         On-link     192.168.1.113    291
        224.0.0.0        240.0.0.0         On-link     192.168.1.113    291
===========================================================================
Persistent Routes:
  Network Address          Netmask  Gateway Address  Metric
          0.0.0.0        128.0.0.0         10.8.0.1       1
`;
// The same machine with a client's split pair over its Wintun adapter (10.8.0.2).
const SPLIT_ROWS = `          0.0.0.0        128.0.0.0         On-link          10.8.0.2      5
        128.0.0.0        128.0.0.0         On-link          10.8.0.2      5
`;
const ROUTE_PRINT_SPLIT = ROUTE_PRINT_IDLE.replace('===========================================================================\nPersistent', `${SPLIT_ROWS}===========================================================================\nPersistent`);
const LAN = { '192.168.1.113': 'Ethernet 2', '127.0.0.1': 'Loopback Pseudo-Interface 1' };
const WITH_WINTUN = { ...LAN, '10.8.0.2': 'HMA VPN Wintun' };
const win = (routes: string, adapters: Record<string, string>): WindowsRouteSnapshot => ({ routes, adapters });

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

describe('isWindowsRouteViaVpn (spec §4.3 Windows detection)', () => {
  it('the plain default route via the LAN adapter is not a VPN (persistent rows are not active routes)', () => {
    expect(isWindowsRouteViaVpn(win(ROUTE_PRINT_IDLE, WITH_WINTUN))).toBe(false);
  });

  it('a split pair via a Wintun adapter that is up is a VPN', () => {
    expect(isWindowsRouteViaVpn(win(ROUTE_PRINT_SPLIT, WITH_WINTUN))).toBe(true);
  });

  it('a route through an address no adapter that is up carries is ignored', () => {
    expect(isWindowsRouteViaVpn(win(ROUTE_PRINT_SPLIT, LAN))).toBe(false);
  });

  it('between two default routes the lower (summed) metric wins', () => {
    const vpnDefault = (metric: number) =>
      ROUTE_PRINT_IDLE.replace('Persistent', `          0.0.0.0          0.0.0.0         10.8.0.1         10.8.0.2     ${metric}\nPersistent`);
    expect(isWindowsRouteViaVpn(win(vpnDefault(5), WITH_WINTUN))).toBe(true);
    expect(isWindowsRouteViaVpn(win(vpnDefault(500), WITH_WINTUN))).toBe(false);
  });

  it('reads a localised table: translated headers, "On-link" and adapter names with spaces', () => {
    const localized = ROUTE_PRINT_SPLIT.replace(/On-link/g, 'Trên liên kết').replace('Active Routes:', 'Tuyến đường hoạt động:');
    expect(isWindowsRouteViaVpn(win(localized, { ...LAN, '10.8.0.2': 'Kết nối VPN của tôi' }))).toBe(true);
  });

  it('unparsable output is treated as inactive', () => {
    expect(isWindowsRouteViaVpn({ routes: 'garbage', adapters: {} })).toBe(false);
  });

  it('only a VPN-named adapter that is up can make it true', () => {
    expect(hasVpnNamedAdapter(LAN)).toBe(false);
    expect(hasVpnNamedAdapter(WITH_WINTUN)).toBe(true);
  });

  it('PPPoE broadband is not a VPN; Windows built-in VPN miniports are', () => {
    expect(hasVpnNamedAdapter({ '100.64.1.2': 'Viettel PPPoE WAN Miniport (PPPoE)', '10.0.0.2': 'PPP adapter' })).toBe(false);
    expect(hasVpnNamedAdapter({ '10.0.0.3': 'Work WAN Miniport (IKEv2)' })).toBe(true);
    expect(hasVpnNamedAdapter({ '10.0.0.4': 'Teredo Tunneling Pseudo-Interface' })).toBe(false);
  });

  it('recognises a VPN adapter by its description when its name is arbitrary (WireGuard tunnel, TAP)', () => {
    const up = { ...LAN, '10.8.0.2': 'office', '10.9.0.2': 'Ethernet 3' };
    const labelled = labelAdapters(up, { office: 'WireGuard Tunnel', 'Ethernet 3': 'TAP-Windows Adapter V9', 'Ethernet 2': 'Intel(R) Ethernet Controller (3) I225-V' });
    expect(labelled['10.8.0.2']).toBe('office WireGuard Tunnel');
    expect(hasVpnNamedAdapter(labelled)).toBe(true);
    expect(isWindowsRouteViaVpn(win(ROUTE_PRINT_SPLIT, labelled))).toBe(true);
    // The names alone say nothing.
    expect(isWindowsRouteViaVpn(win(ROUTE_PRINT_SPLIT, up))).toBe(false);
  });
});

describe('createHostVpnMonitor', () => {
  it('isHostVpnActive on darwin reflects the injected route check', async () => {
    const monitor = createHostVpnMonitor({ platform: 'darwin', runDefaultRouteCheck: async () => ROUTE_VIA_IPSEC0 });
    expect(await monitor.isHostVpnActive()).toBe(true);
  });

  it('isHostVpnActive on win32 reads the route table, not the macOS route check', async () => {
    const monitor = createHostVpnMonitor({
      platform: 'win32',
      runDefaultRouteCheck: async () => ROUTE_VIA_IPSEC0,
      readWindowsRoutes: async () => ROUTE_PRINT_SPLIT,
      readWindowsAdapters: () => WITH_WINTUN,
      describeWindowsAdapters: async () => ({}),
    });
    expect(await monitor.isHostVpnActive()).toBe(true);
  });

  it('isHostVpnActive on win32 reads no route table while no VPN-named adapter is up', async () => {
    let reads = 0;
    const monitor = createHostVpnMonitor({
      platform: 'win32',
      readWindowsRoutes: async () => (reads++, ROUTE_PRINT_SPLIT),
      readWindowsAdapters: () => LAN,
      describeWindowsAdapters: async () => ({}),
    });
    expect(await monitor.isHostVpnActive()).toBe(false);
    expect(reads).toBe(0);
  });

  it('isHostVpnActive on win32 reads descriptions once per set of adapters that are up', async () => {
    let up: Record<string, string> = LAN;
    let described = 0;
    const monitor = createHostVpnMonitor({
      platform: 'win32',
      readWindowsRoutes: async () => ROUTE_PRINT_SPLIT,
      readWindowsAdapters: () => up,
      describeWindowsAdapters: async () => (described++, { office: 'WireGuard Tunnel' }),
    });
    expect(await monitor.isHostVpnActive()).toBe(false);
    expect(await monitor.isHostVpnActive()).toBe(false);
    expect(described).toBe(1);
    up = { ...LAN, '10.8.0.2': 'office' };
    expect(await monitor.isHostVpnActive()).toBe(true);
    expect(await monitor.isHostVpnActive()).toBe(true);
    expect(described).toBe(2);
  });

  it('a failed description lookup is not retried until the adapters that are up change', async () => {
    let up: Record<string, string> = LAN;
    let attempts = 0;
    const monitor = createHostVpnMonitor({
      platform: 'win32',
      readWindowsRoutes: async () => ROUTE_PRINT_SPLIT,
      readWindowsAdapters: () => up,
      describeWindowsAdapters: async () => {
        attempts++;
        throw new Error('powershell missing');
      },
    });
    await monitor.isHostVpnActive();
    await monitor.isHostVpnActive();
    expect(attempts).toBe(1);
    up = WITH_WINTUN;
    await monitor.isHostVpnActive();
    expect(attempts).toBe(2);
  });

  it('isHostVpnActive on win32 still uses names when descriptions cannot be read', async () => {
    const monitor = createHostVpnMonitor({
      platform: 'win32',
      readWindowsRoutes: async () => ROUTE_PRINT_SPLIT,
      readWindowsAdapters: () => WITH_WINTUN,
      describeWindowsAdapters: async () => {
        throw new Error('powershell missing');
      },
    });
    expect(await monitor.isHostVpnActive()).toBe(true);
  });

  it('isHostVpnActive on win32 is false when reading the route table fails', async () => {
    const monitor = createHostVpnMonitor({
      platform: 'win32',
      readWindowsRoutes: async () => {
        throw new Error('route missing');
      },
      readWindowsAdapters: () => WITH_WINTUN,
      describeWindowsAdapters: async () => ({}),
    });
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
