import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, EndpointSpec, ExitIpResult, PortRow, PortState, Provider, RenderInput, Target } from '../../shared/contracts';
import type { SecretStore } from '../store/secrets';
import { createStateStore, type StateStore } from '../store/state';
import { createPortManager, type PortManagerDeps } from './port-manager';
import { PortInUseError, type Engine, type ExitIpProber, type PortAllocator } from './ports';
import { createServerHealth } from './server-health';

function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    saveSecret: (id, plaintext) => void map.set(id, plaintext),
    loadSecret: (id) => map.get(id) ?? null,
    deleteSecret: (id) => void map.delete(id),
  };
}

/**
 * `started`/`stopped` record every call for assertions. `fireState` lets a test
 * simulate `PortHealth`'s own state ownership (reviewer item 6: the real `Engine`
 * drives `connecting`/`verifying`/`online`/`retrying` itself, not port-manager) — tests
 * that care about the resulting `PortRow.state` call it explicitly, decoupling "did
 * port-manager ask the engine to start the right thing" from "what does the engine's
 * own health machine eventually report".
 *
 * `start()` resolves immediately (modeling only "the spawn was initiated"), same as
 * before, but — unless `autoOnline: false` — a REAL (if tiny) timer separately fires an
 * `online` state for that key shortly afterwards (reviewer item 1: "make the fake engine
 * model async handshake so tests catch this"). This is deliberately NOT synchronous
 * with `start()` resolving: a `rotatePort`/`startPort` implementation that (incorrectly)
 * assumes the tunnel is already up the instant `engine.start()` returns would see NO
 * state transition yet and have to actually wait for it, exactly like it would against
 * the real engine. Tests that need full manual control over timing (e.g. to prove a
 * probe never fires before `online`) pass `autoOnline: false` and drive `fireState`
 * themselves.
 */
function fakeEngine(opts: { autoOnline?: boolean } = {}): Engine & {
  started: Array<{ key: string; input: RenderInput }>;
  stopped: string[];
  fireState: (key: string, state: PortState) => void;
  fireRetryDue: (key: string) => void;
} {
  const autoOnline = opts.autoOnline ?? true;
  const started: Array<{ key: string; input: RenderInput }> = [];
  const stopped: string[] = [];
  const stateChangeCbs = new Set<(key: string, state: PortState) => void>();
  const retryDueCbs = new Set<(key: string) => void>();
  function fireState(key: string, state: PortState): void {
    for (const cb of stateChangeCbs) cb(key, state);
  }
  function fireRetryDue(key: string): void {
    for (const cb of retryDueCbs) cb(key);
  }
  return {
    started,
    stopped,
    fireState,
    fireRetryDue,
    start: async (key, input) => {
      started.push({ key, input });
      if (autoOnline) {
        // Exit IP = server IP (spec §6.5), so distinct servers never look like a clash.
        const ep = input.endpoint;
        const exitIp = ep.type === 'wireguard' ? ep.peers[0].address : ep.server;
        const timer = setTimeout(() => fireState(key, { kind: 'online', since: Date.now(), exitIp, country: 'XX' }), 0);
        timer.unref?.();
      }
    },
    stop: async (key) => {
      stopped.push(key);
    },
    probe: async () => ({ code: 200, ms: 10 }),
    getLogs: () => [],
    onStateChange: (cb) => {
      stateChangeCbs.add(cb);
      return () => stateChangeCbs.delete(cb);
    },
    onRetryDue: (cb) => {
      retryDueCbs.add(cb);
      return () => retryDueCbs.delete(cb);
    },
  };
}

/** Queue of results/errors returned in order, one per call to `probe`; also records
 * every call's (port, auth) so tests can assert credentials were actually passed. */
function fakeExitIpProber(
  results: Array<ExitIpResult | Error>,
): ExitIpProber & { calls: Array<{ proxyPort: number; auth: { username: string; password: string } | undefined }> } {
  const queue = [...results];
  const calls: Array<{ proxyPort: number; auth: { username: string; password: string } | undefined }> = [];
  return {
    calls,
    probe: async (proxyPort, auth) => {
      calls.push({ proxyPort, auth });
      const next = queue.shift();
      if (next === undefined) throw new Error('fakeExitIpProber: no more results queued');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** Honours `taken`/`preferred` like the real engine's `allocatePort` (reviewer item 5:
 * the previous fake always returned incrementing ports regardless of `taken`, which
 * hid the duplicate-port bug entirely). */
function fakeAllocator(): PortAllocator & { allocateCalls: Array<{ preferred?: number; taken?: Set<number> }>; allocateAuxCalls: number } {
  let auxNext = 30000;
  const allocateCalls: Array<{ preferred?: number; taken?: Set<number> }> = [];
  const tracker = {
    allocateCalls,
    allocateAuxCalls: 0,
    allocate: async (opts: { preferred?: number; taken?: Set<number>; base?: number } = {}) => {
      allocateCalls.push(opts);
      const taken = opts.taken ?? new Set<number>();
      if (opts.preferred !== undefined && !taken.has(opts.preferred)) return opts.preferred;
      let candidate = opts.base ?? 29001;
      while (taken.has(candidate)) candidate++;
      return candidate;
    },
    allocateAux: async () => {
      tracker.allocateAuxCalls++;
      return auxNext++;
    },
    release: () => undefined,
  };
  return tracker;
}

function fakeProvider(targets: Target[]): Provider {
  return {
    id: targets[0]?.providerId ?? 'zoogvpn',
    check: () => ({ ok: true }),
    targets: async () => targets,
    bind: (target, serverIp): EndpointSpec => ({
      type: 'wireguard',
      address: ['10.14.0.2/16'],
      private_key: 'fake',
      mtu: 1280,
      peers: [{ address: serverIp, port: 51820, public_key: 'fake', allowed_ips: ['0.0.0.0/0'] }],
    }),
  };
}

const account: Account = { id: 'z1', providerId: 'zoogvpn', label: 'z1', meta: {}, secretRef: 'z1-secret' };

/** The pinned server of the row with this port key (or, for a moved row, location key). */
function serverOf(state: StateStore, key: string): string | undefined {
  const ports = state.getState().ports;
  return (ports.find((p) => p.key === key) ?? ports.find((p) => p.locationKey === key))?.server;
}

function basePort(overrides: Partial<PortRow> = {}): PortRow {
  return {
    key: 'zoogvpn:nl-ams',
    locationKey: 'zoogvpn:nl-ams',
    providerId: 'zoogvpn',
    accountId: 'z1',
    label: 'Amsterdam',
    country: 'NL',
    city: 'Amsterdam',
    proxyPort: 29001,
    enabled: true,
    state: { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL' },
    autoRotateMin: 0,
    ...overrides,
  };
}

describe('port manager', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-portmgr-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: {
    targets: Target[];
    port?: Partial<PortRow>;
    exitIpResults?: Array<ExitIpResult | Error>;
    /** The pinned server of the setup row, by its location key (pre-rev-3 `portServers`). */
    portServers?: Record<string, string>;
    engine?: Engine;
    depsOverrides?: Partial<PortManagerDeps>;
  }) {
    const secrets = fakeSecretStore();
    secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
    const state = createStateStore(join(dir, 'state.json'), secrets);
    const row = basePort(opts.port);
    const server = (opts.portServers ?? { 'zoogvpn:nl-ams': '10.0.0.1' })[row.locationKey];
    state.setState((s) => ({
      ...s,
      accounts: [account],
      ports: [server ? { ...row, server } : row],
    }));
    const engine: Engine = opts.engine ?? fakeEngine();
    const exitIp = fakeExitIpProber(opts.exitIpResults ?? []);
    const allocator = fakeAllocator();
    const provider = fakeProvider(opts.targets);
    const deps: PortManagerDeps = {
      state,
      secrets,
      engine,
      providers: { get: () => provider },
      exitIp,
      allocator,
      getLanIPv4: () => '192.168.1.50',
      resolveServer: async (server) => server,
      ...opts.depsOverrides,
    };
    // Cast back to the richer fake shape for the (overwhelmingly common) default case;
    // tests that pass a custom `engine` override hold their own typed reference to it
    // instead of relying on this field.
    return { manager: createPortManager(deps), state, engine: engine as ReturnType<typeof fakeEngine>, secrets, exitIp, allocator };
  }

  describe('rotatePort (spec §6.5)', () => {
    it('{changed:false, noteKey:"no-server"} for a single-server, one-city-country location', async () => {
      const { manager } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, noteKey: 'no-server' });
    });

    it('changed:true when another IP of the same location gives a different exit IP', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }],
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result.changed).toBe(true);
      expect(result.from).toBe('1.1.1.1');
      expect(result.to).toBe('2.2.2.2');
      expect(result.noteKey).toBeUndefined();
      expect(engine.stopped).toEqual(['zoogvpn:nl-ams']);
      expect(engine.started.map((s) => s.key)).toEqual(['zoogvpn:nl-ams']);
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('10.0.0.2');
      // port-manager itself leaves `state` alone (reviewer item 6: PortHealth owns it);
      // it only persists whatever the engine's own onStateChange reports.
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 123, exitIp: '2.2.2.2', country: 'NL' });
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'online', exitIp: '2.2.2.2' });
    });

    it('changed:false when the restart lands on the same exit IP', async () => {
      const { manager } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        exitIpResults: [{ ip: '1.1.1.1', country: 'NL' }],
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, from: '1.1.1.1', to: '1.1.1.1', noteKey: 'exit-ip-unchanged' });
    });

    it('falls back to another location in the same country when the location has only one server', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      const { manager, state } = setup({ targets, exitIpResults: [{ ip: '3.3.3.3', country: 'NL' }] });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result.changed).toBe(true);
      expect(result.noteKey).toBe('rotated-to-another-city');
      const rows = state.getState().ports;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'zoogvpn:nl-rot#1', locationKey: 'zoogvpn:nl-rot', server: '10.0.0.9' });
      expect(rows[0].city).toBe('Rotterdam');
      expect(serverOf(state, 'zoogvpn:nl-rot')).toBe('10.0.0.9');
    });

    it('{changed:false, noteKey:"no-server"} for an unknown port key', async () => {
      const { manager } = setup({ targets: [] });
      const result = await manager.rotatePort('does-not-exist');
      expect(result).toEqual({ changed: false, noteKey: 'no-server' });
    });

    it('noteKey is "probe-failed" and changed is false when the post-restart probe throws', async () => {
      const { manager } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        exitIpResults: [new Error('timeout')],
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, from: '1.1.1.1', to: undefined, noteKey: 'probe-failed' });
    });
  });

  describe('Change IP and listServers on a server pool (spec §6.5, §6.8)', () => {
    const ams = (servers: string[]): Target => ({ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers });
    const boundIp = (input: RenderInput) => (input.endpoint as { peers: Array<{ address: string }> }).peers[0].address;

    /** #1 online on 10.0.0.1 (the setup row) plus #2 holding `held`. */
    function twoPorts(servers: string[], held: string, extra: Parameters<typeof setup>[0] extends infer O ? Partial<O> : never = {}) {
      const ctx = setup({ targets: [ams(servers)], port: { key: 'zoogvpn:nl-ams#1' }, exitIpResults: [{ ip: '9.9.9.9', country: 'NL' }], ...extra });
      ctx.state.setState((s) => ({ ...s, ports: [...s.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: held })] }));
      return ctx;
    }

    it('rotate skips a server another port of the location holds', async () => {
      const { manager, state, engine } = twoPorts(['10.0.0.1', '10.0.0.2', '10.0.0.3'], '10.0.0.2');
      const result = await manager.rotatePort('zoogvpn:nl-ams#1');
      expect(result).toMatchObject({ changed: true, from: '1.1.1.1', to: '9.9.9.9' });
      expect(boundIp(engine.started[0].input)).toBe('10.0.0.3');
      expect(serverOf(state, 'zoogvpn:nl-ams#1')).toBe('10.0.0.3');
    });

    it('rotate with toServer moves to exactly that free usable server', async () => {
      const { manager, state, engine } = twoPorts(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'], '10.0.0.2');
      const result = await manager.rotatePort('zoogvpn:nl-ams#1', '10.0.0.4');
      expect(result.changed).toBe(true);
      expect(boundIp(engine.started[0].input)).toBe('10.0.0.4');
      expect(serverOf(state, 'zoogvpn:nl-ams#1')).toBe('10.0.0.4');
    });

    it('rotate with toServer leaves the port alone when that server is held, unusable, unknown or current', async () => {
      const serverHealth = createServerHealth();
      serverHealth.markRefused('z1', '10.0.0.3');
      const { manager, state, engine } = twoPorts(['10.0.0.1', '10.0.0.2', '10.0.0.3'], '10.0.0.2', { depsOverrides: { serverHealth } });
      expect(await manager.rotatePort('zoogvpn:nl-ams#1', '10.0.0.2')).toEqual({ changed: false, noteKey: 'server-unavailable' }); // held by #2
      expect(await manager.rotatePort('zoogvpn:nl-ams#1', '10.0.0.3')).toEqual({ changed: false, noteKey: 'server-unavailable' }); // refused
      expect(await manager.rotatePort('zoogvpn:nl-ams#1', '10.9.9.9')).toEqual({ changed: false, noteKey: 'server-unavailable' }); // not in the pool
      expect(await manager.rotatePort('zoogvpn:nl-ams#1', '10.0.0.1')).toEqual({ changed: false, noteKey: 'already-on-server' });
      expect(engine.started).toEqual([]);
      expect(serverOf(state, 'zoogvpn:nl-ams#1')).toBe('10.0.0.1');
    });

    it('with no other free server (and no other city) the port keeps its server and says so', async () => {
      const { manager, state, engine } = twoPorts(['10.0.0.1', '10.0.0.2'], '10.0.0.2');
      expect(await manager.rotatePort('zoogvpn:nl-ams#1')).toEqual({ changed: false, noteKey: 'no-server' });
      expect(engine.stopped).toEqual([]);
      expect(serverOf(state, 'zoogvpn:nl-ams#1')).toBe('10.0.0.1');
    });

    it('listServers reports ip, health, lastOk and the holding port; freeServerCount counts usable unheld ones', async () => {
      const serverHealth = createServerHealth();
      serverHealth.markOk('z1', '10.0.0.1');
      serverHealth.markRefused('z1', '10.0.0.3');
      serverHealth.markDead('z1', '10.0.0.4');
      const { manager } = twoPorts(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', 'nl5.example.net'], '10.0.0.2', { depsOverrides: { serverHealth } });
      const target = ams(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', 'nl5.example.net']);
      const list = manager.listServers(target);
      expect(list).toEqual([
        { server: '10.0.0.1', ip: '10.0.0.1', health: 'ok', lastOk: serverHealth.lastOk('z1', '10.0.0.1'), heldBy: 'zoogvpn:nl-ams#1' },
        { server: '10.0.0.2', ip: '10.0.0.2', health: 'unknown', heldBy: 'zoogvpn:nl-ams#2' },
        { server: '10.0.0.3', ip: '10.0.0.3', health: 'refused' },
        { server: '10.0.0.4', ip: '10.0.0.4', health: 'dead' },
        { server: 'nl5.example.net', health: 'unknown' }, // never resolved yet: no ip
      ]);
      expect(manager.freeServerCount(target)).toBe(1);
    });

    it('a stopped port keeps holding its pinned server, so it gets it back on restart', async () => {
      const { manager, state } = twoPorts(['10.0.0.1', '10.0.0.2'], '10.0.0.2');
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === 'zoogvpn:nl-ams#2' ? { ...p, enabled: false, state: { kind: 'stopped' } } : p)) }));
      expect(manager.listServers(ams(['10.0.0.1', '10.0.0.2']))[1].heldBy).toBe('zoogvpn:nl-ams#2');
      expect(await manager.addPort(ams(['10.0.0.1', '10.0.0.2']), 'z1')).toBeUndefined();
    });

    it("health is for the accounts of the location's ports", async () => {
      const serverHealth = createServerHealth();
      serverHealth.markRefused('z2', '10.0.0.3');
      const { manager, state } = twoPorts(['10.0.0.1', '10.0.0.2', '10.0.0.3'], '10.0.0.2', { depsOverrides: { serverHealth } });
      const z2: Account = { ...account, id: 'z2', secretRef: 'z2-secret' };
      state.setState((s) => ({ ...s, accounts: [...s.accounts, z2] }));
      expect(manager.listServers(ams(['10.0.0.1', '10.0.0.2', '10.0.0.3']))[2].health).toBe('unknown'); // ports use z1
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p, accountId: 'z2' })) }));
      expect(manager.listServers(ams(['10.0.0.1', '10.0.0.2', '10.0.0.3']))[2].health).toBe('refused');
    });

    it('one round-robin hostname (a Surfshark cluster before discovery) can back two ports on different IPs', async () => {
      let n = 0;
      const { manager } = setup({ targets: [], depsOverrides: { resolveServer: async () => `203.0.113.${++n}` } });
      const tok: Target = { key: 'surfshark:jp-tok', providerId: 'zoogvpn', country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: ['jp-tok.prod.surfshark.com'] };
      const a = await manager.addPort(tok, 'z1');
      const b = await manager.addPort(tok, 'z1');
      expect([a!.serverIp, b!.serverIp]).toEqual(['203.0.113.1', '203.0.113.2']);
    });

    describe('a pool hostname (Target.poolHostnames, Surfshark before discovery)', () => {
      const HOST = 'jp-tok.prod.surfshark.com';
      const tok = (poolHostnames = true): Target => ({
        key: 'surfshark:jp-tok', providerId: 'surfshark', country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: [HOST], ...(poolHostnames ? { poolHostnames } : {}),
      });
      /** Answers the scripted IPs in order (the last repeats), recording each call's options. */
      function scriptedResolver(answers: string[]) {
        const calls: Array<{ fresh?: boolean } | undefined> = [];
        const resolveServer = async (_server: string, opts?: { fresh?: boolean }) => {
          calls.push(opts);
          return answers[Math.min(calls.length - 1, answers.length - 1)];
        };
        return { resolveServer, calls };
      }
      const surfsharkAccount: Account = { ...account, providerId: 'surfshark' };

      it('a held pool hostname still counts as free (+ Add port stays enabled); listServers still shows its holder', async () => {
        const { manager, state } = setup({ targets: [], depsOverrides: { resolveServer: scriptedResolver(['203.0.113.1']).resolveServer } });
        state.setState((s) => ({ ...s, accounts: [surfsharkAccount], ports: [] }));
        const row = await manager.addPort(tok(), 'z1');
        expect(manager.listServers(tok())).toEqual([{ server: HOST, ip: '203.0.113.1', health: 'unknown', heldBy: row!.key }]);
        expect(manager.freeServerCount(tok())).toBe(1);
        expect(manager.freeServerCount(tok(false))).toBe(0); // a plain hostname is one server
      });

      it('a second port re-resolves past the IP the first one holds', async () => {
        const dns = scriptedResolver(['203.0.113.1', '203.0.113.1', '203.0.113.1', '203.0.113.7']);
        const { manager, state } = setup({ targets: [], depsOverrides: { resolveServer: dns.resolveServer } });
        state.setState((s) => ({ ...s, accounts: [surfsharkAccount], ports: [] }));
        const a = await manager.addPort(tok(), 'z1');
        const b = await manager.addPort(tok(), 'z1');
        expect([a!.serverIp, b!.serverIp]).toEqual(['203.0.113.1', '203.0.113.7']);
        expect(dns.calls.every((o) => o?.fresh === true)).toBe(true); // straight from DNS, not the OS cache
      });

      it('gives up after a few answers that are all held', async () => {
        const dns = scriptedResolver(['203.0.113.1']);
        const { manager, state } = setup({ targets: [], depsOverrides: { resolveServer: dns.resolveServer } });
        state.setState((s) => ({ ...s, accounts: [surfsharkAccount], ports: [] }));
        await manager.addPort(tok(), 'z1');
        dns.calls.length = 0;
        expect(await manager.addPort(tok(), 'z1')).toBeUndefined();
        expect(dns.calls).toHaveLength(4);
      });

      it("a restart of a port pinned to the hostname skips an answer another port's holds", async () => {
        const dns = scriptedResolver(['203.0.113.1', '203.0.113.7']);
        const { manager, state, engine } = setup({
          targets: [tok()],
          port: { key: 'surfshark:jp-tok#2', locationKey: 'surfshark:jp-tok', providerId: 'surfshark', proxyPort: 29002, server: HOST, enabled: false, state: { kind: 'stopped' } },
          portServers: {},
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { resolveServer: dns.resolveServer },
        });
        state.setState((s) => ({
          ...s,
          accounts: [surfsharkAccount],
          ports: [basePort({ key: 'surfshark:jp-tok#1', locationKey: 'surfshark:jp-tok', providerId: 'surfshark', server: HOST, serverIp: '203.0.113.1' }), ...s.ports],
        }));
        await manager.startPort('surfshark:jp-tok#2');
        expect((engine.started[0].input.endpoint as { peers: Array<{ address: string }> }).peers[0].address).toBe('203.0.113.7');
        expect(state.getState().ports[1]).toMatchObject({ server: HOST, serverIp: '203.0.113.7' });
      });
    });
  });

  describe('startPort / stopPort / removePort', () => {
    it('starts an existing port: builds the render input, starts the engine, and records the server', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started).toHaveLength(1);
      expect(engine.started[0].key).toBe('zoogvpn:nl-ams');
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('10.0.0.1');
      expect(state.getState().ports[0].enabled).toBe(true);
    });

    it('resolves a hostname server to an IP before bind (spec §6.1.4), but records the hostname', async () => {
      const resolved: string[] = [];
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['nl1.example.net'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        portServers: {},
        depsOverrides: {
          resolveServer: async (server) => {
            resolved.push(server);
            return '203.0.113.7';
          },
        },
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(resolved).toEqual(['nl1.example.net']);
      const ep = engine.started[0].input.endpoint;
      expect(ep.type === 'wireguard' && ep.peers[0].address).toBe('203.0.113.7');
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('nl1.example.net');
    });

    it('a DNS failure becomes retrying(dns-failed) with no engine start', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['gone.example.net'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        portServers: {},
        depsOverrides: {
          resolveServer: async () => {
            throw new Error('ENOTFOUND');
          },
          scheduleRetry: () => () => undefined,
        },
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started).toHaveLength(0);
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'retrying', reasonKey: 'dns-failed' });
    });

    it("startPort persists whatever PortHealth reports via the engine's onStateChange (reviewer item 6)", async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
      });
      await manager.startPort('zoogvpn:nl-ams');
      engine.fireState('zoogvpn:nl-ams', { kind: 'connecting', since: 1 });
      expect(state.getState().ports[0].state).toEqual({ kind: 'connecting', since: 1 });
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 2, exitIp: '5.5.5.5', country: 'NL' });
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'online', exitIp: '5.5.5.5' });
    });

    it('stopPort stops the engine and marks the port disabled/stopped', async () => {
      const { manager, state, engine } = setup({ targets: [] });
      await manager.stopPort('zoogvpn:nl-ams');
      expect(engine.stopped).toEqual(['zoogvpn:nl-ams']);
      expect(state.getState().ports[0]).toMatchObject({ enabled: false, state: { kind: 'stopped' } });
    });

    it('removePort stops the engine and deletes the row and its server bookkeeping', async () => {
      const { manager, state } = setup({ targets: [] });
      await manager.removePort('zoogvpn:nl-ams');
      expect(state.getState().ports).toEqual([]);
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBeUndefined();
    });
  });

  describe('setAutoRotate', () => {
    it('sets and clamps to >= 0', async () => {
      const { manager, state } = setup({ targets: [] });
      await manager.setAutoRotate('zoogvpn:nl-ams', 30);
      expect(state.getState().ports[0].autoRotateMin).toBe(30);
      await manager.setAutoRotate('zoogvpn:nl-ams', -5);
      expect(state.getState().ports[0].autoRotateMin).toBe(0);
    });
  });

  describe('exportPorts', () => {
    it('formats the selected ports using the account-wide proxy credentials', async () => {
      const { manager, state } = setup({ targets: [] });
      state.setState((s) => ({ ...s, settings: { ...s.settings, proxyUser: 'proxy', proxyPass: 'secretpw' } }));
      const out = await manager.exportPorts(['zoogvpn:nl-ams'], 'hostPortUserPass');
      expect(out).toBe('127.0.0.1:29001:proxy:secretpw');
    });

    it('ignores unknown keys silently', async () => {
      const { manager } = setup({ targets: [] });
      const out = await manager.exportPorts(['nope'], 'hostPort');
      expect(out).toBe('');
    });
  });

  describe('testPort', () => {
    it('reports ok with exit IP and latency on a successful probe', async () => {
      const { manager } = setup({ targets: [], exitIpResults: [{ ip: '9.9.9.9', country: 'NL' }] });
      const result = await manager.testPort('zoogvpn:nl-ams', false);
      expect(result.ok).toBe(true);
      expect(result.exitIp).toBe('9.9.9.9');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports not-ok when the probe fails', async () => {
      const { manager } = setup({ targets: [], exitIpResults: [new Error('timeout')] });
      const result = await manager.testPort('zoogvpn:nl-ams', false);
      expect(result).toEqual({ ok: false });
    });
  });

  describe('addPort (spec §6.8)', () => {
    const ber = (servers: string[]): Target => ({ key: 'zoogvpn:de-ber', providerId: 'zoogvpn', country: 'DE', city: 'Berlin', label: 'Berlin', servers });

    it('creates an enabled, queued row `<location>#1` pinned to the best server, with a persistent proxy port', async () => {
      const { manager, state } = setup({ targets: [] });
      const row = await manager.addPort(ber(['1.2.3.4']), 'z1');
      expect(row).toMatchObject({ key: 'zoogvpn:de-ber#1', locationKey: 'zoogvpn:de-ber', server: '1.2.3.4', serverIp: '1.2.3.4', enabled: true, state: { kind: 'queued' } });
      expect(row!.proxyPort).toBeGreaterThan(0);
      expect(state.getState().ports.some((p) => p.key === 'zoogvpn:de-ber#1')).toBe(true);
    });

    it('n is the smallest free number in that location, starting at 1', async () => {
      const { manager, state } = setup({ targets: [] });
      state.setState((s) => ({
        ...s,
        ports: [
          ...s.ports,
          basePort({ key: 'zoogvpn:de-ber#1', locationKey: 'zoogvpn:de-ber', proxyPort: 29010, enabled: false }),
          basePort({ key: 'zoogvpn:de-ber#3', locationKey: 'zoogvpn:de-ber', proxyPort: 29011, enabled: false }),
        ],
      }));
      const t = ber(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
      expect((await manager.addPort(t, 'z1'))!.key).toBe('zoogvpn:de-ber#2');
      expect((await manager.addPort(t, 'z1'))!.key).toBe('zoogvpn:de-ber#4');
    });

    it('never duplicates a proxy port already held by another row (reviewer item 5)', async () => {
      const { manager, state, allocator } = setup({ targets: [] });
      // the existing row from setup() already holds 29001
      const row = await manager.addPort(ber(['1.2.3.4']), 'z1');
      expect(row!.proxyPort).not.toBe(29001);
      expect(allocator.allocateCalls[0].taken).toEqual(new Set([29001]));
      const ports = state.getState().ports.map((p) => p.proxyPort);
      expect(new Set(ports).size).toBe(ports.length); // no duplicates
    });

    it('each port of a location takes a different server; none left → undefined', async () => {
      const { manager } = setup({ targets: [] });
      const t = ber(['1.1.1.1', '2.2.2.2']);
      const a = await manager.addPort(t, 'z1');
      const b = await manager.addPort(t, 'z1');
      expect([a!.server, b!.server]).toEqual(['1.1.1.1', '2.2.2.2']);
      expect(await manager.addPort(t, 'z1')).toBeUndefined();
    });

    it('best = most recent lastOk for that account, then pool order', async () => {
      const serverHealth = createServerHealth();
      serverHealth.markOk('z1', '3.3.3.3');
      const { manager } = setup({ targets: [], depsOverrides: { serverHealth } });
      expect((await manager.addPort(ber(['1.1.1.1', '2.2.2.2', '3.3.3.3']), 'z1'))!.server).toBe('3.3.3.3');
    });

    it('the invariant compares RESOLVED IPs: two hostnames on one machine are one server', async () => {
      const ips: Record<string, string> = { 'de7.webunlim.com': '185.177.229.121', 'fr4.webunlim.com': '185.177.229.121', 'de9.webunlim.com': '185.177.229.9' };
      const { manager } = setup({ targets: [], depsOverrides: { resolveServer: async (s) => ips[s] } });
      const t = ber(['de7.webunlim.com', 'fr4.webunlim.com', 'de9.webunlim.com']);
      const a = await manager.addPort(t, 'z1');
      const b = await manager.addPort(t, 'z1');
      expect(a!.server).toBe('de7.webunlim.com');
      expect(b!.server).toBe('de9.webunlim.com'); // fr4 skipped: same IP as de7
      expect(await manager.addPort(t, 'z1')).toBeUndefined();
    });

    it('a server refused or dead for this account is not usable; another account may still use it', async () => {
      const serverHealth = createServerHealth();
      serverHealth.markRefused('z1', '1.1.1.1');
      serverHealth.markDead('z1', '2.2.2.2');
      const { manager } = setup({ targets: [], depsOverrides: { serverHealth } });
      const t = ber(['1.1.1.1', '2.2.2.2']);
      expect(await manager.addPort(t, 'z1')).toBeUndefined();
      expect((await manager.addPort(t, 'z2'))!.server).toBe('1.1.1.1');
    });

    it('serializes concurrent adds so they never race onto the same proxy port or server', async () => {
      const { manager } = setup({ targets: [] });
      // An allocator with an artificial delay: without serialization, two concurrent
      // adds would both read "29001 is taken, nothing else is" (and "no server held")
      // before either had written its row back. (`manager` from `setup()` above is
      // unused here; this test rebuilds its own with the slow allocator below.)
      void manager;
      const slowAllocator: PortAllocator = {
        allocate: async (opts = {}) => {
          const before = new Set(opts.taken);
          await new Promise((r) => setTimeout(r, 5));
          let candidate = opts.base ?? 29001;
          while (before.has(candidate)) candidate++;
          return candidate;
        },
        allocateAux: async () => 30000,
        release: () => undefined,
      };
      const secrets = fakeSecretStore();
      secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
      const d = mkdtempSync(join(tmpdir(), 'pf-portmgr-slow-'));
      const state = createStateStore(join(d, 'state.json'), secrets);
      state.setState((s) => ({ ...s, accounts: [account], ports: [basePort()] }));
      const m2 = createPortManager({
        resolveServer: async (server: string) => server,
        state,
        secrets,
        engine: fakeEngine(),
        providers: { get: () => fakeProvider([]) },
        exitIp: fakeExitIpProber([]),
        allocator: slowAllocator,
      });
      const t = ber(['1.1.1.1', '2.2.2.2']);
      const [r1, r2] = await Promise.all([m2.addPort(t, 'z1'), m2.addPort(t, 'z1')]);
      expect(r1!.proxyPort).not.toBe(r2!.proxyPort);
      expect(r1!.server).not.toBe(r2!.server);
      expect([r1!.key, r2!.key].sort()).toEqual(['zoogvpn:de-ber#1', 'zoogvpn:de-ber#2']);
      rmSync(d, { recursive: true, force: true });
    });
  });

  describe('reviewer findings — critical', () => {
    it('critical 1: LAN sharing with no proxy credentials never opens on 0.0.0.0 — forced back to 127.0.0.1', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        exitIpResults: [{ ip: '5.5.5.5', country: 'NL' }],
      });
      state.setState((s) => ({ ...s, settings: { ...s.settings, lanSharing: true, proxyUser: '', proxyPass: '' } }));
      await manager.startPort('zoogvpn:nl-ams');
      const input = engine.started[0].input;
      expect(input.listen.host).toBe('127.0.0.1');
      expect(input.listen.proxyAuth).toBeUndefined();
    });

    it('critical 1: LAN sharing WITH proxy credentials is allowed to listen on 0.0.0.0', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        exitIpResults: [{ ip: '5.5.5.5', country: 'NL' }],
      });
      state.setState((s) => ({ ...s, settings: { ...s.settings, lanSharing: true, proxyUser: 'proxy', proxyPass: 'pw' } }));
      await manager.startPort('zoogvpn:nl-ams');
      const input = engine.started[0].input;
      expect(input.listen.host).toBe('0.0.0.0');
      expect(input.listen.proxyAuth).toEqual({ username: 'proxy', password: 'pw' });
    });

    it('critical 2: a city-fallback rotate stops the OLD key and starts the engine process under the FINAL key', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      const { manager, engine } = setup({ targets, exitIpResults: [{ ip: '3.3.3.3', country: 'NL' }] });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result.noteKey).toBe('rotated-to-another-city');

      // the OLD key's process was stopped, and the engine was started under the NEW key
      expect(engine.stopped).toEqual(['zoogvpn:nl-ams']);
      expect(engine.started.map((s) => s.key)).toEqual(['zoogvpn:nl-rot#1']);

      // the running process is now addressable ONLY via the final key
      await manager.stopPort('zoogvpn:nl-rot#1');
      expect(engine.stopped).toEqual(['zoogvpn:nl-ams', 'zoogvpn:nl-rot#1']);
    });

    it('critical 2: never falls back onto a server another port of that location already holds', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      const { manager, state } = setup({ targets });
      // nl-rot's only server is held by its own port — rotate must not steal it
      state.setState((s) => ({
        ...s,
        ports: [...s.ports, basePort({ key: 'zoogvpn:nl-rot#1', locationKey: 'zoogvpn:nl-rot', city: 'Rotterdam', proxyPort: 29002, server: '10.0.0.9' })],
      }));
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, noteKey: 'no-server' });
    });
  });

  it('integration fix: a file port rotates onto ANOTHER imported file of the same country, switching account', async () => {
    const secrets = fakeSecretStore();
    secrets.saveSecret('f1', JSON.stringify({ kind: 'file', content: 'a' }));
    secrets.saveSecret('f2', JSON.stringify({ kind: 'file', content: 'b' }));
    const state = createStateStore(join(dir, 'state.json'), secrets);
    const files: Account[] = [
      { id: 'file-1', providerId: 'file', label: 'a', meta: { country: 'VN' }, secretRef: 'f1' },
      { id: 'file-2', providerId: 'file', label: 'b', meta: { country: 'VN' }, secretRef: 'f2' },
    ];
    state.setState((s) => ({
      ...s,
      accounts: files,
      ports: [
        {
          ...basePort(),
          key: 'file:file-1#1',
          locationKey: 'file:file-1',
          server: '127.0.0.1',
          providerId: 'file',
          accountId: 'file-1',
          country: 'VN',
          enabled: true,
          state: { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'VN' },
        },
      ],
    }));
    const bound: string[] = [];
    const provider: Provider = {
      id: 'file',
      check: () => ({ ok: true }),
      targets: async (a) => [{ key: `file:${a.id}`, providerId: 'file', country: 'VN', city: a.id, label: a.id, servers: [a.id === 'file-1' ? '127.0.0.1' : '127.0.0.2'] }], // one remote each
      bind: (_t, ip, a): EndpointSpec => {
        bound.push(a.id);
        return { type: 'wireguard', address: ['10.0.0.2/32'], private_key: 'k', mtu: 1280, peers: [{ address: ip, port: 1, public_key: 'p', allowed_ips: ['0.0.0.0/0'] }] };
      },
    };
    const manager = createPortManager({
      state,
      secrets,
      engine: fakeEngine(),
      providers: { get: () => provider },
      exitIp: fakeExitIpProber([{ ip: '2.2.2.2', country: 'VN' }]),
      allocator: fakeAllocator(),
      resolveServer: async (server: string) => server,
    });
    const result = await manager.rotatePort('file:file-1#1');
    expect(result).toMatchObject({ changed: true, noteKey: 'rotated-to-another-city' });
    expect(bound).toEqual(['file-2']);
    expect(state.getState().ports[0]).toMatchObject({ key: 'file:file-2#1', locationKey: 'file:file-2', accountId: 'file-2' });
  });

  describe('reviewer findings — important', () => {
    it("item 3: rotatePort's exit-IP probes are called with the configured proxy credentials (startPort's own verifying-probe moved into the real engine adapter — see engine-adapter.test.ts)", async () => {
      const { manager, state, exitIp } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }],
      });
      state.setState((s) => ({ ...s, settings: { ...s.settings, proxyUser: 'proxy', proxyPass: 'topsecret' } }));
      await manager.rotatePort('zoogvpn:nl-ams');
      expect(exitIp.calls[0].auth).toEqual({ username: 'proxy', password: 'topsecret' });
    });

    it('item 7: a thrown error during startPort leaves the row retrying, not stuck connecting, and still rejects', async () => {
      const { manager, state } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
      });
      // Exercise the real throw path via the engine itself (an unexpected exception from
      // `Engine.start`, not the one specifically-handled `PortInUseError`) — `manager`/
      // `state` from `setup()` above are unused; this test builds its own instance wired
      // to a throwing engine.
      void manager;
      const secrets = fakeSecretStore();
      secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
      const throwingEngine: Engine = {
        start: async () => {
          throw new Error('boom: engine spawn failed unexpectedly');
        },
        stop: async () => undefined,
        probe: async () => ({ code: 'error', message: 'n/a' }),
        getLogs: () => [],
        onStateChange: () => () => undefined,
      };
      const d = mkdtempSync(join(tmpdir(), 'pf-portmgr-throw-'));
      const st = createStateStore(join(d, 'state.json'), secrets);
      st.setState((s) => ({
        ...s,
        accounts: [account],
        ports: [basePort({ enabled: false, state: { kind: 'stopped' }, server: '10.0.0.1' })],
      }));
      const m2 = createPortManager({
        resolveServer: async (server: string) => server,
        state: st,
        secrets,
        engine: throwingEngine,
        providers: {
          get: () =>
            fakeProvider([{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }]),
        },
        exitIp: fakeExitIpProber([]),
        allocator: fakeAllocator(),
        scheduleRetry: () => () => undefined, // don't actually schedule a real retry in this test
      });
      await expect(m2.startPort('zoogvpn:nl-ams')).rejects.toThrow(/boom/);
      expect(st.getState().ports[0].state.kind).toBe('retrying');
      rmSync(d, { recursive: true, force: true });
    });

    it('item 10a: when the exit IP is not already known, a pre-rotate probe establishes a real baseline (never blindly changed:true)', async () => {
      const { manager, exitIp } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        port: { state: { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'x' } }, // not "online": no known exit IP
        exitIpResults: [
          { ip: '1.1.1.1', country: 'NL' }, // pre-rotate baseline probe
          { ip: '1.1.1.1', country: 'NL' }, // post-restart probe: SAME ip
        ],
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(exitIp.calls).toHaveLength(2);
      expect(result).toEqual({ changed: false, from: '1.1.1.1', to: '1.1.1.1', noteKey: 'exit-ip-unchanged' });
    });

    it('item 10a: reports not-verified (never changed:true) when even the pre-rotate baseline probe fails', async () => {
      const { manager } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        port: { state: { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'x' } },
        exitIpResults: [new Error('baseline probe failed'), { ip: '9.9.9.9', country: 'NL' }],
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result.changed).toBe(false);
      expect(result.noteKey).toBe('not-verified');
    });

    it('item 10b: cycles round-robin through every server, not just the first alternate', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['A', 'B', 'C'] },
      ];
      const { manager, state } = setup({
        targets,
        portServers: { 'zoogvpn:nl-ams': 'B' },
        exitIpResults: [
          { ip: '1.1.1.1', country: 'NL' },
          { ip: '2.2.2.2', country: 'NL' },
        ],
      });
      await manager.rotatePort('zoogvpn:nl-ams'); // B -> C
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('C');
      await manager.rotatePort('zoogvpn:nl-ams'); // C -> A (wraps)
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('A');
    });

    it('item 10c: never rotates (or restarts) a disabled port', async () => {
      const { manager, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        port: { enabled: false },
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, noteKey: 'port-disabled' });
      expect(engine.started).toEqual([]);
      expect(engine.stopped).toEqual([]);
    });

    it('item 10d: concurrent rotate calls on the same key never overlap — the second is rejected as in-progress', async () => {
      const { manager } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }],
      });
      const [r1, r2] = await Promise.all([manager.rotatePort('zoogvpn:nl-ams'), manager.rotatePort('zoogvpn:nl-ams')]);
      const results = [r1, r2];
      expect(results.filter((r) => r.noteKey === 'rotate-in-progress')).toHaveLength(1);
    });
  });

  describe('reviewer findings — minors', () => {
    it('a decrypt/secret-read failure is a retryable state, not a terminal failed(auth)', async () => {
      const { manager, state, secrets } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
      });
      secrets.deleteSecret('z1-secret');
      await manager.startPort('zoogvpn:nl-ams');
      const row = state.getState().ports[0];
      expect(row.state.kind).toBe('retrying');
      expect((row.state as any).reasonKey).toBe('secret-unavailable');
    });

    it('exportPorts uses the LAN IPv4 address when lanSharing is on', async () => {
      const { manager, state } = setup({ targets: [] });
      state.setState((s) => ({ ...s, settings: { ...s.settings, lanSharing: true, proxyUser: 'proxy', proxyPass: 'pw' } }));
      const out = await manager.exportPorts(['zoogvpn:nl-ams'], 'hostPort');
      expect(out).toBe('192.168.1.50:29001');
    });
  });

  describe('reviewer item 9: refusal-tracker wiring from the engine state-change feed', () => {
    it('a zoogvpn port reaching online records it, persisted into AppState.refusals', async () => {
      const { manager, state, engine } = setup({ targets: [] });
      void manager;
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL' });
      expect(state.getState().refusals.online.z1?.['10.0.0.1']).toBeTypeOf('number');
    });

    it('a zoogvpn port reaching failed(auth) records an auth failure for its server, persisted into AppState.refusals', async () => {
      const { state, engine } = setup({ targets: [] });
      engine.fireState('zoogvpn:nl-ams', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
      expect(state.getState().refusals.failures.z1?.['10.0.0.1']).toBeTypeOf('number');
    });

    it('a non-online state clears a previously recorded online marker', async () => {
      const { state, engine } = setup({ targets: [] });
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL' });
      expect(state.getState().refusals.online.z1?.['10.0.0.1']).toBeTypeOf('number');
      engine.fireState('zoogvpn:nl-ams', { kind: 'stopped' });
      expect(state.getState().refusals.online.z1?.['10.0.0.1']).toBeUndefined();
    });

    it('a non-zoogvpn provider is never fed into the refusal tracker', async () => {
      const { state, engine } = setup({ targets: [], port: { providerId: 'hma' as any } });
      engine.fireState('zoogvpn:nl-ams', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
      expect(state.getState().refusals.failures).toEqual({});
    });

    it('seeds the tracker from AppState.refusals already on disk (survives a restart)', async () => {
      const secrets = fakeSecretStore();
      secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
      const d = mkdtempSync(join(tmpdir(), 'pf-portmgr-refusal-seed-'));
      const state = createStateStore(join(d, 'state.json'), secrets);
      const seedTimestamps = { a: Date.now(), b: Date.now(), c: Date.now() };
      state.setState((s) => ({
        ...s,
        accounts: [account],
        ports: [basePort({ server: '10.0.0.1' })],
        refusals: { failures: { z1: seedTimestamps }, online: {} },
      }));
      const engine = fakeEngine();
      const m2 = createPortManager({
        resolveServer: async (server: string) => server,
        state,
        secrets,
        engine,
        providers: { get: () => fakeProvider([]) },
        exitIp: fakeExitIpProber([]),
        allocator: fakeAllocator(),
      });
      void m2;
      // A fresh mutation (a new online marker) must be layered onto the SEEDED failures
      // from disk, not replace them — proving the tracker really was hydrated from
      // `AppState.refusals` at construction, not started empty.
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL' });
      expect(state.getState().refusals.failures.z1).toEqual(seedTimestamps);
      expect(state.getState().refusals.online.z1?.['10.0.0.1']).toBeTypeOf('number');
      rmSync(d, { recursive: true, force: true });
    });
  });

  describe('fix round 2', () => {
    it('item 1: never probes the post-restart exit IP before the port actually reaches online', async () => {
      const engine = fakeEngine({ autoOnline: false });
      const { manager, exitIp } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }],
        engine,
      });
      const resultPromise = manager.rotatePort('zoogvpn:nl-ams');

      // Give a (hypothetically buggy) implementation every chance to probe immediately
      // after `engine.start()` resolves, before asserting it never actually did.
      await new Promise((r) => setTimeout(r, 20));
      expect(exitIp.calls).toHaveLength(0);

      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: Date.now(), exitIp: 'ignored-by-design', country: 'NL' });
      const result = await resultPromise;
      expect(exitIp.calls).toHaveLength(1);
      expect(result.to).toBe('2.2.2.2');
    });

    it('item 1: gives up (noteKey "online-timeout") rather than hanging forever if online never arrives', async () => {
      const engine = fakeEngine({ autoOnline: false });
      const { manager } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        engine,
        depsOverrides: { rotateOnlineTimeoutMs: 20 },
      });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, from: '1.1.1.1', to: undefined, noteKey: 'online-timeout' });
    });

    it('item 2: a state event fired SYNCHRONOUSLY inside engine.start lands on the RENAMED row, not dropped', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      // The worst-case ordering for the old bug: the engine reports a state transition
      // for `finalKey` BEFORE `start()` even resolves. If the row is renamed only after
      // `engine.start()` returns (the old code), `updatePort`'s `.map()` finds no row
      // keyed `finalKey` yet and silently drops this event.
      const stateChangeCbs = new Set<(key: string, state: PortState) => void>();
      const engine: Engine & { started: string[] } = {
        started: [],
        start: async (key) => {
          engine.started.push(key);
          for (const cb of stateChangeCbs) cb(key, { kind: 'connecting', since: 1 });
        },
        stop: async () => undefined,
        probe: async () => ({ code: 'error', message: 'n/a' }),
        getLogs: () => [],
        onStateChange: (cb) => {
          stateChangeCbs.add(cb);
          return () => stateChangeCbs.delete(cb);
        },
      };
      const { manager, state } = setup({
        targets,
        engine,
        exitIpResults: [],
        depsOverrides: { rotateOnlineTimeoutMs: 20 }, // online never arrives; times out quickly
      });
      await manager.rotatePort('zoogvpn:nl-ams'); // falls back to nl-rot (single-server location)
      const row = state.getState().ports.find((p) => p.key === 'zoogvpn:nl-rot#1');
      expect(row).toBeDefined();
      expect(row!.state).toEqual({ kind: 'connecting', since: 1 });
    });

    it('item 3: two concurrent rotates falling back within the same country never produce duplicate keys', async () => {
      // The two existing rows are kept under keys that are NOT themselves in the
      // provider's catalog (a renamed/retired location id, say) — so neither rotate's
      // own `currentTarget` ever matches, forcing BOTH straight into the fallback branch,
      // and — crucially — renaming one of them away never "frees up" a key the other
      // could legitimately claim (there's nothing in the catalog under the vacated key to
      // begin with). The catalog has exactly ONE real alternative (`zoogvpn:nl-rot`), so
      // under genuine scarcity exactly one of the two concurrent rotates can claim it.
      const targets: Target[] = [{ key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] }];
      // An artificial delay on `targets()` forces the two rotates' pre-lock work to
      // genuinely overlap — maximizing the chance a missing/broken lock would let both
      // claim the same alt target (reviewer item 3).
      const slowProvider: Provider = {
        id: 'zoogvpn',
        check: () => ({ ok: true }),
        targets: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return targets;
        },
        bind: (target, serverIp): EndpointSpec => ({
          type: 'wireguard',
          address: ['10.14.0.2/16'],
          private_key: 'fake',
          mtu: 1280,
          peers: [{ address: serverIp, port: 51820, public_key: 'fake', allowed_ips: ['0.0.0.0/0'] }],
        }),
      };
      const secrets = fakeSecretStore();
      secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
      const state = createStateStore(join(dir, 'state.json'), secrets);
      state.setState((s) => ({
        ...s,
        accounts: [account],
        ports: [
          basePort({ key: 'zoogvpn:nl-bogus1#1', locationKey: 'zoogvpn:nl-bogus1', city: 'Bogus1', proxyPort: 29001 }),
          basePort({
            key: 'zoogvpn:nl-bogus2#1',
            locationKey: 'zoogvpn:nl-bogus2',
            city: 'Bogus2',
            proxyPort: 29002,
            state: { kind: 'online', since: 1, exitIp: '1.1.1.2', country: 'NL' },
          }),
        ],
      }));
      const engine = fakeEngine();
      const exitIp = fakeExitIpProber([
        { ip: '2.2.2.2', country: 'NL' },
        { ip: '2.2.2.3', country: 'NL' },
      ]);
      const manager = createPortManager({
        resolveServer: async (server: string) => server,
        state,
        secrets,
        engine,
        providers: { get: () => slowProvider },
        exitIp,
        allocator: fakeAllocator(),
      });

      const [r1, r2] = await Promise.all([manager.rotatePort('zoogvpn:nl-bogus1#1'), manager.rotatePort('zoogvpn:nl-bogus2#1')]);

      const keys = state.getState().ports.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length); // never a duplicate key
      expect(keys).toContain('zoogvpn:nl-rot#1'); // the one real alt server WAS claimed by someone

      // Exactly one of the two could claim the only available alt server;
      // the other must find nothing left and report so, never silently stealing it.
      const results = [r1, r2];
      expect(results.filter((r) => r.noteKey === 'rotated-to-another-city')).toHaveLength(1);
      expect(results.filter((r) => r.noteKey === 'no-server')).toHaveLength(1);
    });

    it('item 7: a real timer behind a retrying row actually retries startPort once the scheduled backoff elapses', async () => {
      const pendingRetries: Array<() => void> = [];
      const scheduleRetry = (_ms: number, cb: () => void): (() => void) => {
        pendingRetries.push(cb);
        return () => {
          const i = pendingRetries.indexOf(cb);
          if (i !== -1) pendingRetries.splice(i, 1);
        };
      };
      const { manager, state, secrets, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        depsOverrides: { scheduleRetry },
      });
      secrets.deleteSecret('z1-secret'); // simulate the account secret being unreadable right now
      await manager.startPort('zoogvpn:nl-ams');
      expect(state.getState().ports[0].state.kind).toBe('retrying');
      expect(engine.started).toHaveLength(0); // never got far enough to touch the engine
      expect(pendingRetries).toHaveLength(1);

      // The secret becomes readable again before the scheduled retry fires (e.g.
      // safeStorage recovers) — firing the scheduled callback must actually re-attempt
      // `startPort`, not just sit there forever (the original bug: `untilMs` was set in
      // the state but nothing was ever scheduled to act on it).
      secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
      const retry = pendingRetries[0];
      pendingRetries.length = 0;
      retry();
      await new Promise((r) => setTimeout(r, 0)); // let the retried startPort's awaits settle

      expect(engine.started).toHaveLength(1);
      expect(engine.started[0].key).toBe('zoogvpn:nl-ams');
    });

    it('item 8: syncAutoRotate is exported, and called internally after start/stop/remove/setAutoRotate/rotate', async () => {
      const autoRotate = { sync: vi.fn(), stopAll: vi.fn() };
      const { manager, state } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }],
        depsOverrides: { autoRotate },
      });

      await manager.setAutoRotate('zoogvpn:nl-ams', 15);
      expect(autoRotate.sync).toHaveBeenLastCalledWith(state.getState().ports);

      autoRotate.sync.mockClear();
      await manager.startPort('zoogvpn:nl-ams');
      expect(autoRotate.sync).toHaveBeenCalled();

      autoRotate.sync.mockClear();
      await manager.rotatePort('zoogvpn:nl-ams');
      expect(autoRotate.sync).toHaveBeenCalled();

      autoRotate.sync.mockClear();
      await manager.stopPort('zoogvpn:nl-ams');
      expect(autoRotate.sync).toHaveBeenCalled();

      autoRotate.sync.mockClear();
      manager.syncAutoRotate();
      expect(autoRotate.sync).toHaveBeenCalledTimes(1);

      autoRotate.sync.mockClear();
      await manager.removePort('zoogvpn:nl-ams');
      expect(autoRotate.sync).toHaveBeenCalled();
    });

    it('item 10: rotate reports a distinct noteKey when the account secret cannot be decrypted (never "no-server")', async () => {
      const { manager, secrets } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
      });
      secrets.deleteSecret('z1-secret');
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, noteKey: 'decrypt-failed' });
    });

    it('item 10: buildRenderInput never allocates an aux (clash) port — the real engine adapter allocates its own', async () => {
      const { manager, allocator } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(allocator.allocateAuxCalls).toBe(0);
    });
  });

  describe('fix round 3', () => {
    it('item 2: a city-fallback rotate whose engine.start throws AFTER the rename marks the FINAL key retrying, not the stale original key', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      // `stop()` succeeds (the OLD key's process genuinely goes away); `start()` under
      // the FINAL key then throws — a real-world `PortInUseError` racing the rename.
      const engine: Engine = {
        start: async () => {
          throw new PortInUseError(12345);
        },
        stop: async () => undefined,
        probe: async () => ({ code: 'error', message: 'n/a' }),
        getLogs: () => [],
        onStateChange: () => () => undefined,
      };
      const { manager, state } = setup({
        targets,
        engine,
        exitIpResults: [],
        // Don't actually schedule a real backoff timer in this test — just prove the
        // right row/state gets marked, which is what the real timer would act on.
        depsOverrides: { scheduleRetry: () => () => undefined },
      });

      await expect(manager.rotatePort('zoogvpn:nl-ams')).rejects.toThrow();

      const rows = state.getState().ports;
      expect(rows).toHaveLength(1);
      // The row WAS renamed to the fallback target before the throw...
      expect(rows[0].key).toBe('zoogvpn:nl-rot#1');
      // ...and it is THIS row — not a (non-existent) 'zoogvpn:nl-ams' row — that ends up
      // retrying. Before the fix, `failWithRetry` was called with the STALE original
      // key, matched no row at all, and left this one stuck on its stale pre-rotate
      // `state` (here: 'online') forever, with no retry timer ever scheduled.
      expect(rows[0].state.kind).toBe('retrying');
      expect((rows[0].state as { reasonKey: string }).reasonKey).toBe('rotate-error');
    });
  });

  describe('Change IP vs a pending local retry', () => {
    /** Captures `scheduleRetry` callbacks; cancelling removes one. */
    function retryRecorder() {
      const pending: Array<() => void> = [];
      const scheduleRetry = (_ms: number, cb: () => void): (() => void) => {
        pending.push(cb);
        return () => {
          const i = pending.indexOf(cb);
          if (i !== -1) pending.splice(i, 1);
        };
      };
      return { pending, scheduleRetry };
    }

    it('a failed(no-server) port moved to another city by Change IP: the old retry is cancelled and a stale one stays quiet', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      const retries = retryRecorder();
      const { manager, state, engine } = setup({
        targets,
        port: { key: 'zoogvpn:nl-ams#1', enabled: false, state: { kind: 'stopped' } },
        portServers: {},
        exitIpResults: [{ ip: '5.5.5.5', country: 'NL' }, { ip: '6.6.6.6', country: 'NL' }],
        depsOverrides: { scheduleRetry: retries.scheduleRetry },
      });
      // Another port holds Amsterdam's only server, so #1 fails with no-server and waits.
      state.setState((s) => ({
        ...s,
        ports: [...s.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: '10.0.0.1', enabled: false, state: { kind: 'stopped' } })],
      }));
      await manager.startPort('zoogvpn:nl-ams#1');
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'failed', reason: 'no-server' });
      expect(retries.pending).toHaveLength(1);
      const stale = retries.pending[0];

      const result = await manager.rotatePort('zoogvpn:nl-ams#1');
      expect(result.noteKey).toBe('rotated-to-another-city');
      expect(state.getState().ports[0].key).toBe('zoogvpn:nl-rot#1');
      expect(retries.pending).toHaveLength(0); // cancelled by the rotate

      // Even a timer that already fired finds no row under the old key: no throw, no new
      // retry scheduled for a ghost key, nothing restarted.
      const startedBefore = engine.started.length;
      stale();
      await new Promise((r) => setTimeout(r, 10));
      expect(retries.pending).toHaveLength(0);
      expect(engine.started).toHaveLength(startedBefore);
      expect(state.getState().ports.map((p) => p.key)).toEqual(['zoogvpn:nl-rot#1', 'zoogvpn:nl-ams#2']);
    });

    it('startPort on a key with no row returns quietly (no throw, no retry)', async () => {
      const retries = retryRecorder();
      const { manager } = setup({ targets: [], depsOverrides: { scheduleRetry: retries.scheduleRetry } });
      await expect(manager.startPort('zoogvpn:gone#1')).resolves.toBeUndefined();
      expect(retries.pending).toHaveLength(0);
    });

    it('a same-location Change IP is not torn down by the old retry firing mid-rotate', async () => {
      const servers = ['10.0.0.1', '10.0.0.2'];
      const ams: Target = { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers };
      let gate: Promise<void> | undefined;
      const provider = { ...fakeProvider([ams]), targets: async () => (await gate, [ams]) };
      const retries = retryRecorder();
      const { manager, state, engine, secrets } = setup({
        targets: [ams],
        exitIpResults: [{ ip: '1.1.1.1', country: 'NL' }, { ip: '2.2.2.2', country: 'NL' }],
        depsOverrides: { scheduleRetry: retries.scheduleRetry, providers: { get: () => provider } },
      });
      // An unreadable secret leaves the port retrying on a local timer.
      secrets.deleteSecret('z1-secret');
      await manager.startPort('zoogvpn:nl-ams');
      expect(retries.pending).toHaveLength(1);
      secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));

      let release!: () => void;
      gate = new Promise((r) => (release = r));
      const rotating = manager.rotatePort('zoogvpn:nl-ams');
      // The timer fires while the rotate is still looking up the location.
      retries.pending.shift()!();
      await new Promise((r) => setTimeout(r, 10));
      expect(engine.started).toHaveLength(0); // no competing start
      expect(retries.pending).toHaveLength(1); // still owed, should the rotate not move the port
      release();
      const result = await rotating;
      expect(result.changed).toBe(true);
      expect(retries.pending).toHaveLength(0); // the rotate restarted the port: nothing owed
      expect(engine.started.map((s) => s.key)).toEqual(['zoogvpn:nl-ams']);
      expect(state.getState().ports[0].server).toBe('10.0.0.2');
    });
  });

  describe('server-pool failover (spec §6.8)', () => {
    const twoServerTargets: Target[] = [
      { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] },
    ];
    const boundIp = (input: RenderInput) => (input.endpoint as { peers: Array<{ address: string }> }).peers[0].address;

    it('startPort keeps the pinned server while usable, and skips it once dead', async () => {
      const serverHealth = createServerHealth();
      const { manager, state, engine } = setup({
        targets: twoServerTargets,
        port: { enabled: false, state: { kind: 'stopped' } },
        portServers: { 'zoogvpn:nl-ams': '10.0.0.2' },
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { serverHealth },
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(boundIp(engine.started[0].input)).toBe('10.0.0.2'); // pinned, though not first in the pool
      serverHealth.markDead('z1', '10.0.0.2');
      await manager.startPort('zoogvpn:nl-ams');
      expect(boundIp(engine.started[1].input)).toBe('10.0.0.1');
      expect(state.getState().ports[0]).toMatchObject({ server: '10.0.0.1', serverIp: '10.0.0.1' });
    });

    it('a connectivity retry marks the server dead for the account and moves the port at once', async () => {
      const serverHealth = createServerHealth();
      const { manager, state, engine } = setup({
        targets: twoServerTargets,
        port: { enabled: false, state: { kind: 'stopped' } },
        portServers: { 'zoogvpn:nl-ams': '10.0.0.1' },
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { serverHealth },
      });
      await manager.startPort('zoogvpn:nl-ams');
      // 504 black hole -> PortHealth drops to retrying('timeout').
      engine.fireState('zoogvpn:nl-ams', { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' });
      expect(serverHealth.isDead('z1', '10.0.0.1')).toBe(true);
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'retrying', reasonKey: 'server-dead' });
      await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      expect(boundIp(engine.started[1].input)).toBe('10.0.0.2');
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('10.0.0.2');
    });

    it('with every server dead the port stays retrying on the normal back-off; the due retry still tries', async () => {
      const { manager, state, engine } = setup({
        targets: [{ ...twoServerTargets[0], servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        engine: fakeEngine({ autoOnline: false }),
      });
      await manager.startPort('zoogvpn:nl-ams');
      engine.fireState('zoogvpn:nl-ams', { kind: 'retrying', untilMs: 99, attempt: 1, reasonKey: 'timeout' });
      await new Promise((r) => setTimeout(r, 10));
      expect(engine.started).toHaveLength(1); // nowhere to move: no immediate restart
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'retrying', reasonKey: 'timeout' });
      engine.fireRetryDue('zoogvpn:nl-ams');
      await vi.waitFor(() => expect(engine.started).toHaveLength(2)); // dead marks never strand a port
    });

    it('a ZoogVPN auth failure with no other evidence is a credential problem: nothing marked, nothing moved', async () => {
      const serverHealth = createServerHealth();
      const { manager, engine } = setup({
        targets: twoServerTargets,
        port: { enabled: false, state: { kind: 'stopped' } },
        portServers: { 'zoogvpn:nl-ams': '10.0.0.1' },
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { serverHealth },
      });
      await manager.startPort('zoogvpn:nl-ams');
      engine.fireState('zoogvpn:nl-ams', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
      await new Promise((r) => setTimeout(r, 10));
      expect(serverHealth.isUsable('z1', '10.0.0.1')).toBe(true);
      expect(engine.started).toHaveLength(1);
    });

    describe('ZoogVPN plan refusal (spec §5.2)', () => {
      const z2: Account = { id: 'z2', providerId: 'zoogvpn', label: 'z2', meta: {}, secretRef: 'z2-secret' };
      const ams = (servers: string[]): Target => ({ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers });

      /** Two ports of one account: #1 online on 10.0.0.1 (so the account works), #2 on `second`. */
      function planSetup(servers: string[], second: string, opts: { accounts?: Account[]; pool?: PortManagerDeps['pool'] } = {}) {
        const serverHealth = createServerHealth();
        const ctx = setup({
          targets: [ams(servers)],
          port: { key: 'zoogvpn:nl-ams#1', state: { kind: 'online', since: 1, exitIp: '10.0.0.1', country: 'NL' } },
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { serverHealth, pool: opts.pool },
        });
        ctx.secrets.saveSecret('z2-secret', JSON.stringify({ kind: 'userpass', username: 'u2', password: 'p2' }));
        ctx.state.setState((s) => ({
          ...s,
          accounts: opts.accounts ?? s.accounts,
          ports: [...s.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: second, state: { kind: 'connecting', since: 1 } })],
        }));
        ctx.engine.fireState('zoogvpn:nl-ams#1', { kind: 'online', since: 1, exitIp: '10.0.0.1', country: 'NL' });
        return { ...ctx, serverHealth };
      }

      it('refused while another server of the account works → refused for 7 days, port moves to the next free server', async () => {
        const { engine, state, serverHealth, manager } = planSetup(['10.0.0.1', '10.0.0.2', '10.0.0.3'], '10.0.0.2');
        // The failover's start reads the location from the last start/add of the port.
        await manager.startPort('zoogvpn:nl-ams#2');
        engine.started.length = 0;
        engine.fireState('zoogvpn:nl-ams#2', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        expect(serverHealth.isRefused('z1', '10.0.0.2')).toBe(true);
        expect(state.getState().serverHealth.refused.z1?.['10.0.0.2']).toBeTypeOf('number'); // persisted
        expect(state.getState().ports[1].state).toMatchObject({ kind: 'retrying', reasonKey: 'server-refused' });
        await vi.waitFor(() => expect(engine.started).toHaveLength(1));
        expect(engine.started[0].key).toBe('zoogvpn:nl-ams#2');
        expect(boundIp(engine.started[0].input)).toBe('10.0.0.3'); // 10.0.0.1 is held by #1
      });

      it('none left for the account → moves to another account that may still use a free server', async () => {
        const pool = { pickAccount: vi.fn(() => z2) };
        const { engine, state, manager } = planSetup(['10.0.0.1', '10.0.0.2'], '10.0.0.2', { accounts: [account, z2], pool });
        await manager.startPort('zoogvpn:nl-ams#2');
        engine.started.length = 0;
        engine.fireState('zoogvpn:nl-ams#2', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        expect(pool.pickAccount).toHaveBeenCalledWith('zoogvpn', { exclude: 'z1', forPortKey: 'zoogvpn:nl-ams#2' });
        await vi.waitFor(() => expect(engine.started).toHaveLength(1));
        expect(state.getState().ports[1].accountId).toBe('z2');
        expect(boundIp(engine.started[0].input)).toBe('10.0.0.2'); // refused for z1 only
      });

      it('none left anywhere → failed(not-in-plan)', async () => {
        const { engine, state, manager } = planSetup(['10.0.0.1', '10.0.0.2'], '10.0.0.2');
        await manager.startPort('zoogvpn:nl-ams#2');
        engine.started.length = 0;
        engine.fireState('zoogvpn:nl-ams#2', { kind: 'failed', reason: 'auth', untilMs: 7, attempt: 1 });
        await new Promise((r) => setTimeout(r, 10));
        expect(engine.started).toHaveLength(0);
        expect(state.getState().ports[1].state).toEqual({ kind: 'failed', reason: 'not-in-plan', untilMs: 7, attempt: 1 });
      });
    });

    describe('HMA per-server auth failover', () => {
      const hmaTarget = (servers: string[]): Target => ({
        key: 'hma:VN-51-HANOI', providerId: 'hma', country: 'VN', city: 'Hanoi', label: 'Hanoi', servers,
      });
      const hmaSetup = (servers: string[], serverHealth = createServerHealth()) => {
        const targets = [hmaTarget(servers)];
        const ctx = setup({
          targets,
          port: { key: 'hma:VN-51-HANOI#1', locationKey: 'hma:VN-51-HANOI', providerId: 'hma', country: 'VN', city: 'Hanoi', label: 'Hanoi', enabled: false, state: { kind: 'stopped' } },
          portServers: {},
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { serverHealth, providers: { get: () => fakeProvider(targets) } },
        });
        return { ...ctx, serverHealth };
      };

      it('a server that refuses the device is marked refused and the port moves to the next server', async () => {
        const { manager, engine, state, serverHealth } = hmaSetup(['10.9.0.1', '10.9.0.2']);
        await manager.startPort('hma:VN-51-HANOI#1');
        expect(boundIp(engine.started[0].input)).toBe('10.9.0.1');

        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });

        expect(serverHealth.isRefused('z1', '10.9.0.1')).toBe(true);
        // Shown as a transient switch, not as "sign-in rejected".
        const row = state.getState().ports.find((p) => p.key === 'hma:VN-51-HANOI#1')!;
        expect(row.state).toMatchObject({ kind: 'retrying', reasonKey: 'server-refused' });
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
        expect(boundIp(engine.started[1].input)).toBe('10.9.0.2');
        expect(serverOf(state, 'hma:VN-51-HANOI#1')).toBe('10.9.0.2');
      });

      it('with no other server left, the auth failure stays terminal and nothing restarts', async () => {
        const { manager, engine, state } = hmaSetup(['10.9.0.1']);
        await manager.startPort('hma:VN-51-HANOI#1');
        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });

        await new Promise((r) => setTimeout(r, 20));
        expect(engine.started).toHaveLength(1);
        const row = state.getState().ports.find((p) => p.key === 'hma:VN-51-HANOI#1')!;
        expect(row.state).toMatchObject({ kind: 'failed', reason: 'auth' });
      });

      it('stops failing over once every server of the location has refused; the long back-off still retries', async () => {
        const serverHealth = createServerHealth();
        serverHealth.markRefused('z1', '10.9.0.2'); // already refused earlier
        const { manager, engine, state } = hmaSetup(['10.9.0.1', '10.9.0.2'], serverHealth);
        await manager.startPort('hma:VN-51-HANOI#1');
        expect(boundIp(engine.started[0].input)).toBe('10.9.0.1');
        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });

        await new Promise((r) => setTimeout(r, 20));
        expect(engine.started).toHaveLength(1);
        expect(state.getState().ports.find((p) => p.key === 'hma:VN-51-HANOI#1')!.state).toMatchObject({ kind: 'failed', reason: 'auth' });
        engine.fireRetryDue('hma:VN-51-HANOI#1');
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      });
    });

    it("exit-IP clash: a port whose exit IP equals another enabled port's moves to another server", async () => {
      const pool: Target = { ...twoServerTargets[0], servers: ['10.0.0.1', '10.0.0.5', '10.0.0.2'] };
      const { manager, state, engine } = setup({
        targets: [pool],
        port: { key: 'zoogvpn:nl-ams#1', state: { kind: 'online', since: 1, exitIp: '198.51.100.7', country: 'NL' } },
        engine: fakeEngine({ autoOnline: false }),
      });
      state.setState((s) => ({
        ...s,
        ports: [...s.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: '10.0.0.5', enabled: false, state: { kind: 'stopped' } })],
      }));
      await manager.startPort('zoogvpn:nl-ams#2');
      expect(boundIp(engine.started[0].input)).toBe('10.0.0.5');
      // Different server IPs, one machine behind them: the probe sees #1's exit IP.
      engine.fireState('zoogvpn:nl-ams#2', { kind: 'online', since: 2, exitIp: '198.51.100.7', country: 'NL' });
      expect(state.getState().ports[1].state).toMatchObject({ kind: 'retrying', reasonKey: 'duplicate-exit' });
      await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      expect(boundIp(engine.started[1].input)).toBe('10.0.0.2');
    });

    it('a single-host target re-resolves its one server on retry (§5.3 Surfshark), re-deriving the IP', async () => {
      const resolved: string[] = [];
      let nth = 0;
      const { manager, engine } = setup({
        targets: [{ key: 'surfshark:jp-tok', providerId: 'surfshark', country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: ['jp-tok.prod.surfshark.com'] }],
        port: { key: 'surfshark:jp-tok#1', locationKey: 'surfshark:jp-tok', providerId: 'surfshark', country: 'JP', city: 'Tokyo', label: 'Tokyo', enabled: false, state: { kind: 'stopped' } },
        portServers: {},
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: {
          providers: { get: () => fakeProvider([{ key: 'surfshark:jp-tok', providerId: 'surfshark', country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: ['jp-tok.prod.surfshark.com'] }]) },
          resolveServer: async (server) => {
            resolved.push(server);
            nth += 1;
            return `203.0.113.${nth}`; // a fresh IP each resolve
          },
        },
      });
      await manager.startPort('surfshark:jp-tok#1');
      expect(boundIp(engine.started[0].input)).toBe('203.0.113.1');

      engine.fireState('surfshark:jp-tok#1', { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' });
      engine.fireRetryDue('surfshark:jp-tok#1');
      await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      // The one hostname was resolved again, yielding a different IP (the real §5.3 fix).
      expect(resolved).toEqual(['jp-tok.prod.surfshark.com', 'jp-tok.prod.surfshark.com']);
      expect(boundIp(engine.started[1].input)).toBe('203.0.113.2');
    });
  });
});
