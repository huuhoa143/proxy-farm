import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, EndpointSpec, ExitIpResult, PortRow, PortState, Provider, RenderInput, Target } from '../../shared/contracts';
import type { SecretStore } from '../store/secrets';
import { createStateStore, type AppState, type StateStore } from '../store/state';

type AppStateCredentials = AppState['credentials'];
import { createPortManager, type PortManagerDeps } from './port-manager';
import { PortInUseError, type Engine, type ExitIpProber, type PortAllocator } from './ports';
import { createServerHealth } from './server-health';
import { createAttemptLimiter, createWgKeyGuard } from './provider-safety';

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
  started: Array<{ key: string; input: RenderInput; attempt?: number }>;
  stopped: string[];
  fireState: (key: string, state: PortState) => void;
  fireRetryDue: (key: string) => void;
} {
  const autoOnline = opts.autoOnline ?? true;
  const started: Array<{ key: string; input: RenderInput; attempt?: number }> = [];
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
    start: async (key, input, startOpts) => {
      started.push({ key, input, attempt: startOpts?.attempt });
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

/** A ZoogVPN-style free-tier location (spec §5.2): its presence among a provider's
 * targets turns on the live credential check on an auth failure. */
const freeTier: Target = {
  key: 'zoogvpn:free',
  providerId: 'zoogvpn',
  country: 'NL',
  city: 'Netherlands',
  label: 'Netherlands',
  servers: ['nl.zgfree.info'],
  freeTierServers: ['nl.zgfree.info'],
};

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
      // Beyond resetting the moved row to `connecting`, port-manager leaves `state` to
      // PortHealth (reviewer item 6): it persists whatever onStateChange reports.
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

    it('a move to another city is reported (movedTo) even when the new exit IP is not confirmed', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      const { manager, state } = setup({ targets, exitIpResults: [new Error('ip echo down')] });
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toMatchObject({ changed: false, noteKey: 'rotated-to-another-city', movedTo: 'Rotterdam' });
      expect(state.getState().ports[0].key).toBe('zoogvpn:nl-rot#1');
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

  describe('a server change never shows the old tunnel as online', () => {
    const ams = (servers: string[]): Target => ({ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers });
    const rot: Target = { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] };

    /** An engine that records the moved row's state at the moment the old tunnel is
     * stopped and the new one started — the window in which the proxy port is down. */
    function observingEngine(rowState: () => PortState | undefined) {
      const engine = fakeEngine();
      const seen: Array<{ at: 'stop' | 'start'; state: PortState | undefined }> = [];
      const { stop, start } = engine;
      engine.stop = async (key) => {
        seen.push({ at: 'stop', state: rowState() });
        await stop(key);
      };
      engine.start = async (key, input) => {
        seen.push({ at: 'start', state: rowState() });
        await start(key, input);
      };
      return { engine, seen };
    }

    function expectConnectingThroughout(seen: Array<{ state: PortState | undefined }>): void {
      expect(seen.length).toBeGreaterThan(0);
      for (const { state } of seen) {
        expect(state?.kind).toBe('connecting');
        expect(state).not.toHaveProperty('exitIp');
        expect(state).not.toHaveProperty('latencyMs');
      }
    }

    it('a move to another city drops the old online state with the rename, before the engine restarts', async () => {
      let rows: () => PortRow[] = () => [];
      const { engine, seen } = observingEngine(() => rows()[0]?.state);
      const { manager, state } = setup({
        targets: [ams(['10.0.0.1']), rot],
        port: { state: { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL', latencyMs: 40 } },
        engine,
        exitIpResults: [{ ip: '3.3.3.3', country: 'NL' }],
      });
      rows = () => state.getState().ports;
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result.noteKey).toBe('rotated-to-another-city');
      expect(seen.map((s) => s.at)).toEqual(['stop', 'start']);
      expectConnectingThroughout(seen);
      expect(state.getState().ports[0]).toMatchObject({ key: 'zoogvpn:nl-rot#1', state: { kind: 'online', exitIp: '10.0.0.9' } });
    });

    it('a same-location Change IP does the same', async () => {
      let rows: () => PortRow[] = () => [];
      const { engine, seen } = observingEngine(() => rows()[0]?.state);
      const { manager, state } = setup({ targets: [ams(['10.0.0.1', '10.0.0.2'])], engine, exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }] });
      rows = () => state.getState().ports;
      expect((await manager.rotatePort('zoogvpn:nl-ams')).changed).toBe(true);
      expectConnectingThroughout(seen);
    });

    it('so does a Change IP to a picked server', async () => {
      let rows: () => PortRow[] = () => [];
      const { engine, seen } = observingEngine(() => rows()[0]?.state);
      const { manager, state } = setup({ targets: [ams(['10.0.0.1', '10.0.0.2'])], engine, exitIpResults: [{ ip: '2.2.2.2', country: 'NL' }] });
      rows = () => state.getState().ports;
      expect((await manager.rotatePort('zoogvpn:nl-ams', '10.0.0.2')).changed).toBe(true);
      expectConnectingThroughout(seen);
    });

    it('a restart that fails over to another server shows connecting, not the reason it left', async () => {
      const serverHealth = createServerHealth();
      let rows: () => PortRow[] = () => [];
      const { engine, seen } = observingEngine(() => rows()[0]?.state);
      const { manager, state } = setup({ targets: [ams(['10.0.0.1', '10.0.0.2'])], engine, depsOverrides: { serverHealth } });
      rows = () => state.getState().ports;
      serverHealth.markDead('z1', '10.0.0.1');
      await manager.startPort('zoogvpn:nl-ams');
      expect(serverOf(state, 'zoogvpn:nl-ams')).toBe('10.0.0.2');
      expectConnectingThroughout(seen);
    });

    it('a restart on the same server leaves the state to the engine', async () => {
      let rows: () => PortRow[] = () => [];
      const { engine, seen } = observingEngine(() => rows()[0]?.state);
      const { manager, state } = setup({
        targets: [ams(['10.0.0.1', '10.0.0.2'])],
        port: { serverIp: '10.0.0.1', state: { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' } },
        engine,
      });
      rows = () => state.getState().ports;
      await manager.startPort('zoogvpn:nl-ams');
      expect(seen).toEqual([{ at: 'start', state: expect.objectContaining({ kind: 'retrying' }) }]);
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
      const list = await manager.listServers(target);
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
      expect((await manager.listServers(ams(['10.0.0.1', '10.0.0.2'])))[1].heldBy).toBe('zoogvpn:nl-ams#2');
      expect(await manager.addPort(ams(['10.0.0.1', '10.0.0.2']), 'z1')).toBeUndefined();
    });

    it("health is for the accounts of the location's ports", async () => {
      const serverHealth = createServerHealth();
      serverHealth.markRefused('z2', '10.0.0.3');
      const { manager, state } = twoPorts(['10.0.0.1', '10.0.0.2', '10.0.0.3'], '10.0.0.2', { depsOverrides: { serverHealth } });
      const z2: Account = { ...account, id: 'z2', secretRef: 'z2-secret' };
      state.setState((s) => ({ ...s, accounts: [...s.accounts, z2] }));
      expect((await manager.listServers(ams(['10.0.0.1', '10.0.0.2', '10.0.0.3'])))[2].health).toBe('unknown'); // ports use z1
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p, accountId: 'z2' })) }));
      expect((await manager.listServers(ams(['10.0.0.1', '10.0.0.2', '10.0.0.3'])))[2].health).toBe('refused');
    });

    it("with a port key, health is for that port's account only (its Change-IP menu)", async () => {
      const serverHealth = createServerHealth();
      serverHealth.markRefused('z2', '10.0.0.3'); // refused for z2, unknown for z1
      serverHealth.markDead('z1', '10.0.0.4'); // dead for z1, unknown for z2
      const pool = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];
      const { manager, state } = twoPorts(pool, '10.0.0.2', { depsOverrides: { serverHealth } });
      const z2: Account = { ...account, id: 'z2', secretRef: 'z2-secret' };
      state.setState((s) => ({ ...s, accounts: [...s.accounts, z2], ports: s.ports.map((p) => (p.key === 'zoogvpn:nl-ams#2' ? { ...p, accountId: 'z2' } : p)) }));
      const health = async (portKey?: string) => (await manager.listServers(ams(pool), portKey)).slice(2).map((s) => s.health);
      expect(await health()).toEqual(['unknown', 'unknown']); // merged: usable by one of z1/z2 each
      expect(await health('zoogvpn:nl-ams#1')).toEqual(['unknown', 'dead']);
      expect(await health('zoogvpn:nl-ams#2')).toEqual(['refused', 'unknown']);
      expect(await health('zoogvpn:nl-ams#9')).toEqual(['unknown', 'unknown']); // unknown port: merged
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
        expect(await manager.listServers(tok())).toEqual([{ server: HOST, ip: '203.0.113.1', health: 'unknown', heldBy: row!.key }]);
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

    it('an online latency refresh updates the row but is not treated as a new online transition', async () => {
      const serverHealth = createServerHealth();
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { serverHealth },
      });
      await manager.startPort('zoogvpn:nl-ams');
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 5, exitIp: '10.0.0.1', country: 'NL', latencyMs: 80 });
      const markOk = vi.spyOn(serverHealth, 'markOk');
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 5, exitIp: '10.0.0.1', country: 'NL', latencyMs: 64 });
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'online', latencyMs: 64 });
      expect(markOk).not.toHaveBeenCalled();
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

    describe('Stop while a start is in flight', () => {
      const ams: Target = { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] };

      it('a stop during the location lookup wins: the start aborts and the row stays stopped', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const provider = { ...fakeProvider([ams]), targets: async () => (await gate, [ams]) };
        const { manager, state, engine } = setup({ targets: [ams], port: { state: { kind: 'queued' } }, depsOverrides: { providers: { get: () => provider } } });
        const starting = manager.startPort('zoogvpn:nl-ams');
        await manager.stopPort('zoogvpn:nl-ams');
        release();
        await starting;
        expect(engine.started).toHaveLength(0);
        expect(state.getState().ports[0]).toMatchObject({ enabled: false, state: { kind: 'stopped' } });
      });

      it('a stop while the claim resolves the server wins too', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { manager, state, engine } = setup({
          targets: [ams],
          port: { state: { kind: 'queued' } },
          depsOverrides: { resolveServer: async (server) => (await gate, server) },
        });
        const starting = manager.startPort('zoogvpn:nl-ams');
        await new Promise((r) => setTimeout(r, 0)); // into the claim, waiting on DNS
        await manager.stopPort('zoogvpn:nl-ams');
        release();
        await starting;
        expect(engine.started).toHaveLength(0);
        expect(state.getState().ports[0]).toMatchObject({ enabled: false, state: { kind: 'stopped' } });
      });
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

    it('asks atLimit inside the claim lock, so concurrent adds never overshoot the port limit', async () => {
      const { manager, state } = setup({ targets: [] });
      // One enabled port already; a limit of 2 leaves one slot for two concurrent adds.
      const atLimit = () => state.getState().ports.filter((p) => p.enabled).length >= 2;
      const t = ber(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
      const [r1, r2] = await Promise.all([manager.addPort(t, 'z1', { atLimit }), manager.addPort(t, 'z1', { atLimit })]);
      expect([r1, r2].filter(Boolean)).toHaveLength(1);
      expect(state.getState().ports).toHaveLength(2);
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
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }, freeTier],
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { credentialProbe: async () => ({ outcome: 'unreachable' }) },
      });
      await manager.startPort('zoogvpn:nl-ams');
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

    describe('sticky exit IP: drops vs dead servers (spec §6.4)', () => {
      const pool = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];
      const drop = { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' } as const;
      const online = (ip: string) => ({ kind: 'online', since: Math.random(), exitIp: ip, country: 'NL' }) as const;

      /** #1 on 10.0.0.1 and #2 on 10.0.0.2, both started and online; a settable clock. */
      async function twoOnline() {
        const serverHealth = createServerHealth();
        const clock = { t: 1_000_000 };
        const ctx = setup({
          targets: [{ ...twoServerTargets[0], servers: pool }],
          port: { key: 'zoogvpn:nl-ams#1', enabled: false, state: { kind: 'stopped' } },
          portServers: { 'zoogvpn:nl-ams': '10.0.0.1' },
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { serverHealth, now: () => clock.t },
        });
        ctx.state.setState((s) => ({
          ...s,
          ports: [...s.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: '10.0.0.2', enabled: false, state: { kind: 'stopped' } })],
        }));
        await ctx.manager.startPort('zoogvpn:nl-ams#1');
        await ctx.manager.startPort('zoogvpn:nl-ams#2');
        ctx.engine.fireState('zoogvpn:nl-ams#1', online('10.0.0.1'));
        ctx.engine.fireState('zoogvpn:nl-ams#2', online('10.0.0.2'));
        ctx.engine.started.length = 0;
        /** The back-off elapses: the port restarts (a fresh reconnect); returns the IP it bound. */
        const retry = async (key: string) => {
          const n = ctx.engine.started.length;
          ctx.engine.fireRetryDue(key);
          await vi.waitFor(() => expect(ctx.engine.started).toHaveLength(n + 1));
          return boundIp(ctx.engine.started[n].input);
        };
        return { ...ctx, serverHealth, clock, retry };
      }

      it('a lone drop of an online port marks nothing and reconnects to the same server', async () => {
        const { engine, serverHealth, retry } = await twoOnline();
        engine.fireState('zoogvpn:nl-ams#1', drop);
        await new Promise((r) => setTimeout(r, 10));
        expect(engine.started).toHaveLength(0); // no move
        expect(serverHealth.isUsable('z1', '10.0.0.1')).toBe(true);
        expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.1');
      });

      it('the server a port was online on is given up only after failed fresh reconnects in a row', async () => {
        const { engine, serverHealth, retry, clock, state } = await twoOnline();
        engine.fireState('zoogvpn:nl-ams#1', drop);
        clock.t += 60_000;
        expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.1');
        engine.fireState('zoogvpn:nl-ams#1', drop); // first failed reconnect: still sticky
        expect(serverHealth.isUsable('z1', '10.0.0.1')).toBe(true);
        clock.t += 60_000;
        expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.1');
        engine.fireState('zoogvpn:nl-ams#1', drop); // second: the server is dead
        expect(serverHealth.isDead('z1', '10.0.0.1')).toBe(true);
        await vi.waitFor(() => expect(serverOf(state, 'zoogvpn:nl-ams#1')).toBe('10.0.0.3'));
      });

      it('a server the port never got online on is still condemned on its first failure', async () => {
        const { engine, serverHealth, state, retry } = await twoOnline();
        engine.fireState('zoogvpn:nl-ams#1', drop);
        serverHealth.markDead('z1', '10.0.0.1'); // say it went away for good
        expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.3'); // a new pin
        engine.fireState('zoogvpn:nl-ams#1', drop);
        expect(serverHealth.isDead('z1', '10.0.0.3')).toBe(true);
        await vi.waitFor(() => expect(serverOf(state, 'zoogvpn:nl-ams#1')).toBe('10.0.0.4'));
      });

      it('ports of one provider failing together are an incident: nothing is marked, nothing moves, until it is over', async () => {
        const { engine, serverHealth, retry, clock, state } = await twoOnline();
        engine.fireState('zoogvpn:nl-ams#1', drop);
        clock.t += 3_000;
        engine.fireState('zoogvpn:nl-ams#2', drop);
        // Both reconnect to their own servers and keep failing while the incident lasts.
        for (let round = 0; round < 3; round++) {
          clock.t += 40_000;
          expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.1');
          engine.fireState('zoogvpn:nl-ams#1', drop);
          clock.t += 2_000;
          expect(await retry('zoogvpn:nl-ams#2')).toBe('10.0.0.2');
          engine.fireState('zoogvpn:nl-ams#2', drop);
        }
        expect(pool.every((s) => serverHealth.isUsable('z1', s))).toBe(true);
        expect([serverOf(state, 'zoogvpn:nl-ams#1'), serverOf(state, 'zoogvpn:nl-ams#2')]).toEqual(['10.0.0.1', '10.0.0.2']);

        // Long after it, a lone server that still fails its reconnects is judged normally.
        clock.t += 10 * 60_000;
        expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.1');
        engine.fireState('zoogvpn:nl-ams#1', drop);
        clock.t += 60_000;
        expect(await retry('zoogvpn:nl-ams#1')).toBe('10.0.0.1');
        engine.fireState('zoogvpn:nl-ams#1', drop);
        expect(serverHealth.isDead('z1', '10.0.0.1')).toBe(true);
      });

      it('ports of two providers failing together are a host-wide incident', async () => {
        const { engine, serverHealth, state, clock } = await twoOnline();
        // An HMA port whose server never got online (alone, that failure would condemn it).
        state.setState((s) => ({
          ...s,
          accounts: [...s.accounts, { ...account, id: 'h1', providerId: 'hma' }],
          ports: [...s.ports, basePort({ key: 'hma:VN#1', locationKey: 'hma:VN', providerId: 'hma', accountId: 'h1', proxyPort: 29003, server: '10.9.0.1', state: { kind: 'connecting', since: 1 } })],
        }));
        engine.fireState('zoogvpn:nl-ams#1', drop);
        clock.t += 5_000;
        engine.fireState('hma:VN#1', drop);
        expect(serverHealth.isUsable('h1', '10.9.0.1')).toBe(true);
        expect(serverHealth.isUsable('z1', '10.0.0.1')).toBe(true);
      });
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

    it('an account over its attempt budget waits for a token: retrying(rate-limited), no engine start, retried later', async () => {
      const timers: Array<{ ms: number; cb: () => void }> = [];
      const { manager, engine, state } = setup({
        targets: [{ ...twoServerTargets[0], servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: {
          attemptLimiter: createAttemptLimiter({ now: () => 0, perMinute: 1 }),
          scheduleRetry: (ms, cb) => {
            timers.push({ ms, cb });
            return () => undefined;
          },
        },
      });
      await manager.startPort('zoogvpn:nl-ams');
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started).toHaveLength(1);
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'retrying', reasonKey: 'rate-limited' });
      expect(timers.map((t) => t.ms)).toEqual([60_000]);
      expect(await manager.rotatePort('zoogvpn:nl-ams')).toEqual({ changed: false, noteKey: 'rate-limited' });
    });

    it('the back-off carries across engine restarts (spec §6.4) and a user Start resets it', async () => {
      const { manager, engine } = setup({
        targets: [{ ...twoServerTargets[0], servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        engine: fakeEngine({ autoOnline: false }),
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started[0].attempt).toBe(0);
      engine.fireState('zoogvpn:nl-ams', { kind: 'retrying', untilMs: 99, attempt: 3, reasonKey: 'exited' });
      engine.fireRetryDue('zoogvpn:nl-ams');
      await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      expect(engine.started[1].attempt).toBe(3); // not back to the 30 s step
      await manager.startPort('zoogvpn:nl-ams', { user: true });
      expect(engine.started[2].attempt).toBe(0);
    });

    it('reaching online resets the carried back-off', async () => {
      const { manager, engine } = setup({
        targets: [{ ...twoServerTargets[0], servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        engine: fakeEngine({ autoOnline: false }),
      });
      await manager.startPort('zoogvpn:nl-ams');
      engine.fireState('zoogvpn:nl-ams', { kind: 'retrying', untilMs: 99, attempt: 2, reasonKey: 'exited' });
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 5, exitIp: '10.0.0.1', country: 'NL' });
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started[1].attempt).toBe(0);
    });

    describe('ZoogVPN plan vs password: the free-tier check (spec §5.2)', () => {
      const ams = (servers: string[]): Target => ({ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers });
      const authFailed: PortState = { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 };

      /** One stopped port on 10.0.0.1 of a 4-server location; `probe` answers the check. */
      function checkSetup(outcome: 'ok' | 'auth' | 'unreachable' | (() => Promise<{ outcome: 'ok' | 'auth' | 'unreachable' }>), opts: { credentials?: AppStateCredentials } = {}) {
        const serverHealth = createServerHealth();
        const probe = vi.fn(typeof outcome === 'function' ? outcome : async () => ({ outcome, host: 'nl.zgfree.info' }));
        const ctx = setup({
          targets: [ams(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']), freeTier],
          port: { enabled: false, state: { kind: 'stopped' } },
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { serverHealth, credentialProbe: probe, attemptLimiter: { take: () => 0 } },
        });
        if (opts.credentials) ctx.state.setState((st) => ({ ...st, credentials: opts.credentials! }));
        return { ...ctx, serverHealth, probe, stateOf: () => ctx.state.getState().ports[0].state };
      }

      it('an unknown login is checked on a free-tier server first; while it runs the port waits with its engine stopped', async () => {
        let answer!: (r: { outcome: 'ok' }) => void;
        const { manager, engine, probe, stateOf } = checkSetup(() => new Promise((r) => (answer = r)));
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        expect(probe).toHaveBeenCalledTimes(1);
        expect((probe.mock.calls[0] as unknown[])[0]).toMatchObject({ id: 'z1' });
        expect(stateOf()).toMatchObject({ kind: 'retrying', reasonKey: 'checking-sign-in' });
        await vi.waitFor(() => expect(engine.stopped).toContain('zoogvpn:nl-ams'));
        expect(engine.started).toHaveLength(1);
        answer({ outcome: 'ok' });
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      });

      it('the free host accepts the login → verified (persisted), the server is a plan refusal: refused 7 days, the port moves', async () => {
        const { manager, engine, state, serverHealth, stateOf } = checkSetup('ok');
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
        expect(state.getState().credentials.z1).toMatchObject({ state: 'verified', verifiedAt: expect.any(Number) });
        expect(serverHealth.isRefused('z1', '10.0.0.1')).toBe(true);
        expect(boundIp(engine.started[1].input)).toBe('10.0.0.2');
        expect(stateOf()).toMatchObject({ kind: 'connecting' });
        // Verified now: the next refusal is a plan refusal at once, no second check.
        engine.fireState('zoogvpn:nl-ams', authFailed);
        expect(stateOf()).toMatchObject({ kind: 'retrying', reasonKey: 'server-not-in-plan' });
        expect(serverHealth.isRefused('z1', '10.0.0.2')).toBe(true);
      });

      it('the free host refuses the login too → wrong email or password: terminal, no walk, marks made on the assumption dropped', async () => {
        const { manager, engine, state, serverHealth, stateOf, probe } = checkSetup('auth');
        serverHealth.markRefused('z1', '10.0.0.4'); // a refusal recorded while the login was never verified
        state.setState((st) => ({
          ...st,
          ports: [...st.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: '10.0.0.3', state: { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' } })],
        }));
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        await vi.waitFor(() => expect(stateOf()).toMatchObject({ kind: 'failed', reason: 'auth', detail: 'wrong-credentials' }));
        // Every port of the account that is not up fails with it; nothing is marked refused.
        expect(state.getState().ports[1].state).toMatchObject({ kind: 'failed', reason: 'auth', detail: 'wrong-credentials' });
        expect(serverHealth.isRefused('z1', '10.0.0.1')).toBe(false);
        expect(serverHealth.isRefused('z1', '10.0.0.4')).toBe(false);
        expect(state.getState().credentials.z1).toMatchObject({ state: 'rejected' });
        await new Promise((r) => setTimeout(r, 10));
        expect(engine.started).toHaveLength(1);
        expect(engine.stopped).toContain('zoogvpn:nl-ams');
        // Known wrong now: the user's Start tries again, and a refusal fails it at once.
        await manager.startPort('zoogvpn:nl-ams', { user: true });
        engine.fireState('zoogvpn:nl-ams', authFailed);
        expect(stateOf()).toMatchObject({ kind: 'failed', reason: 'auth', detail: 'wrong-credentials' });
        expect(probe).toHaveBeenCalledTimes(1);
      });

      it('no free host reachable → only the last resort: dead (not refused) marks, then "could not verify" after 3 servers; one check per 10 min', async () => {
        const { manager, engine, state, serverHealth, stateOf, probe } = checkSetup('unreachable');
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
        expect(serverHealth.isDead('z1', '10.0.0.1')).toBe(true);
        expect(serverHealth.isRefused('z1', '10.0.0.1')).toBe(false);
        expect(state.getState().credentials.z1).toMatchObject({ state: 'unverified' });
        engine.fireState('zoogvpn:nl-ams', authFailed);
        await vi.waitFor(() => expect(engine.started).toHaveLength(3));
        engine.fireState('zoogvpn:nl-ams', authFailed);
        await new Promise((r) => setTimeout(r, 10));
        expect(engine.started).toHaveLength(3);
        expect(stateOf()).toMatchObject({ kind: 'failed', reason: 'auth', detail: 'unverified-login' });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(serverHealth.serialize().refused).toEqual({});
      });

      it('a verified login never triggers a check: the refusal is the plan', async () => {
        const { manager, engine, serverHealth, probe, stateOf } = checkSetup('auth', { credentials: { z1: { state: 'verified', at: 1, verifiedAt: 1 } } });
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        expect(serverHealth.isRefused('z1', '10.0.0.1')).toBe(true);
        expect(stateOf()).toMatchObject({ kind: 'retrying', reasonKey: 'server-not-in-plan' });
        expect(probe).not.toHaveBeenCalled();
      });

      it('a location where every server refuses a working login → failed(not-in-plan, location-not-in-plan); a stale login is re-checked', async () => {
        const { manager, engine, state, serverHealth, probe, stateOf } = checkSetup('auth', { credentials: { z1: { state: 'verified', at: 1, verifiedAt: 1 } } });
        for (const ip of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) serverHealth.markRefused('z1', ip);
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        expect(stateOf()).toMatchObject({ kind: 'failed', reason: 'not-in-plan', detail: 'location-not-in-plan' });
        // Nothing of the account is up, and the login was verified long ago: check it again.
        expect(probe).toHaveBeenCalledTimes(1);
        // It turns out wrong now (a new password on the website): the plan was not to blame.
        await vi.waitFor(() => expect(stateOf()).toMatchObject({ kind: 'failed', reason: 'auth', detail: 'wrong-credentials' }));
        expect(state.getState().credentials.z1).toMatchObject({ state: 'rejected', verifiedAt: 1 });
        expect(serverHealth.serialize().refused).toEqual({}); // all made after verifiedAt
      });

      it('ports of one account refused together share one check', async () => {
        let answer!: (r: { outcome: 'ok' }) => void;
        const { manager, engine, state, probe } = checkSetup(() => new Promise((r) => (answer = r)));
        state.setState((st) => ({ ...st, ports: [...st.ports, basePort({ key: 'zoogvpn:nl-ams#2', proxyPort: 29002, server: '10.0.0.2', enabled: false, state: { kind: 'stopped' } })] }));
        await manager.startPort('zoogvpn:nl-ams');
        await manager.startPort('zoogvpn:nl-ams#2');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        engine.fireState('zoogvpn:nl-ams#2', authFailed);
        expect(probe).toHaveBeenCalledTimes(1);
        answer({ outcome: 'ok' });
        await vi.waitFor(() => expect(engine.started).toHaveLength(4));
        expect(new Set(engine.started.slice(2).map((st) => boundIp(st.input)))).toEqual(new Set(['10.0.0.3', '10.0.0.4']));
      });

      it('a port reaching online verifies the login; new credentials drop the check, and an old check still running is ignored', async () => {
        let answer!: (r: { outcome: 'auth' }) => void;
        const { manager, engine, state, stateOf } = checkSetup(() => new Promise((r) => (answer = r)));
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 1, exitIp: '10.0.0.1', country: 'NL' });
        expect(state.getState().credentials.z1).toMatchObject({ state: 'verified' });
        manager.credentialsChanged('z1');
        expect(state.getState().credentials.z1).toBeUndefined();
        engine.fireState('zoogvpn:nl-ams', authFailed); // probe of the current creds starts
        manager.credentialsChanged('z1'); // …and they are replaced while it runs
        answer({ outcome: 'auth' });
        // Not failed(wrong-credentials): the port tries again, with the new credentials.
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
        expect(state.getState().credentials.z1).toBeUndefined();
        expect(stateOf()).not.toMatchObject({ kind: 'failed' });
      });

      it('a provider whose every server checks the login (ExpressVPN): a login checked at add time does not make an auth failure a plan refusal', async () => {
        const serverHealth = createServerHealth();
        const probe = vi.fn(async () => ({ outcome: 'ok' as const, host: '10.0.0.4' }));
        const provider = { ...fakeProvider([ams(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'])]), anyServerChecksLogin: true };
        const { manager, engine, state } = setup({
          targets: [],
          port: { enabled: false, state: { kind: 'stopped' } },
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { serverHealth, credentialProbe: probe, attemptLimiter: { take: () => 0 }, providers: { get: () => provider } },
        });
        await manager.startPort('zoogvpn:nl-ams');
        // Re-added (say a new password) while the port runs.
        expect(await manager.checkCredentials(account, { kind: 'userpass', username: 'u', password: 'p' })).toBe('verified');
        engine.fireState('zoogvpn:nl-ams', authFailed);
        // The login is wrong now (changed on the website): the port stops, it does not walk
        // the location marking servers refused for a week.
        await vi.waitFor(() => expect(state.getState().ports[0].state).toMatchObject({ kind: 'failed', reason: 'auth' }));
        expect(engine.started).toHaveLength(1);
        expect(serverHealth.serialize().refused).toEqual({});
        expect(probe).toHaveBeenCalledTimes(1);
      });

      it('engine events of a credential probe are not port events', async () => {
        const { engine, state } = checkSetup('ok');
        const before = JSON.stringify(state.getState().ports);
        engine.fireState('probe:z1:1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        engine.fireRetryDue('probe:z1:1');
        await new Promise((r) => setTimeout(r, 10));
        expect(JSON.stringify(state.getState().ports)).toBe(before);
        expect(engine.started).toHaveLength(0);
      });

      it('checkCredentials runs one probe and stores nothing; recordCredentialCheck stores the verdict', async () => {
        const { manager, state, probe } = checkSetup('ok');
        const secret = { kind: 'userpass' as const, username: 'me', password: 'new' };
        expect(await manager.checkCredentials(account, secret)).toBe('verified');
        expect(probe).toHaveBeenCalledWith(account, secret, expect.anything());
        expect(state.getState().credentials.z1).toBeUndefined();
        manager.recordCredentialCheck('z1', 'unverified');
        expect(state.getState().credentials.z1).toMatchObject({ state: 'unverified' });
        manager.recordCredentialCheck('z1', 'verified');
        expect(state.getState().credentials.z1).toMatchObject({ state: 'verified' });
      });
    });

    describe('credential probes never share a proxy port', () => {
      it('two probes at once get different loopback ports, neither a port row\'s, and give them back when done', async () => {
        const engine = fakeEngine({ autoOnline: false });
        const { manager, state, secrets } = setup({ targets: [freeTier], engine });
        const z2: Account = { ...account, id: 'z2', label: 'z2', secretRef: 'z2-secret' };
        secrets.saveSecret('z2-secret', JSON.stringify({ kind: 'userpass', username: 'u2', password: 'p2' }));
        state.setState((s) => ({ ...s, accounts: [account, z2] }));
        const secret = { kind: 'userpass' as const, username: 'u', password: 'p' };
        const a = manager.checkCredentials(account, secret);
        const b = manager.checkCredentials(z2, secret);
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
        const ports = engine.started.map((s) => s.input.listen.port);
        expect(new Set(ports).size).toBe(2);
        expect(ports).not.toContain(29001); // the port row's
        for (const s of engine.started) engine.fireState(s.key, { kind: 'verifying', since: 1 });
        expect(await a).toBe('verified');
        expect(await b).toBe('verified');
        // Released: the next probe may use the first port again.
        const c = manager.checkCredentials(account, secret);
        await vi.waitFor(() => expect(engine.started).toHaveLength(3));
        expect(engine.started[2].input.listen.port).toBe(Math.min(...ports));
        engine.fireState(engine.started[2].key, { kind: 'verifying', since: 1 });
        await c;
      });
    });

    describe('ZoogVPN plan refusal (spec §5.2)', () => {
      const z2: Account = { id: 'z2', providerId: 'zoogvpn', label: 'z2', meta: {}, secretRef: 'z2-secret' };
      const ams = (servers: string[]): Target => ({ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers });

      /** Two ports of one account: #1 online on 10.0.0.1 (so the account works), #2 on `second`. */
      function planSetup(servers: string[], second: string, opts: { accounts?: Account[]; pool?: PortManagerDeps['pool'] } = {}) {
        const serverHealth = createServerHealth();
        const ctx = setup({
          targets: [ams(servers), freeTier],
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
        expect(state.getState().ports[1].state).toMatchObject({ kind: 'retrying', reasonKey: 'server-not-in-plan' });
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

    describe('a Change IP onto a server that refuses the account (spec §6.5, §6.8)', () => {
      const de = (servers: string[]): Target => ({ key: 'zoogvpn:DE', providerId: 'zoogvpn', country: 'DE', city: 'Germany', label: 'Germany', countryWide: true, servers });
      const pool = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
      const refusing = new Set(['10.0.0.5', '10.0.0.6']);

      /** One port online on 10.0.0.3 (so its login is verified). The fake engine refuses
       * the login on `refusing` servers and brings every other server online. */
      function rotateSetup(servers = pool) {
        const serverHealth = createServerHealth();
        const engine = fakeEngine({ autoOnline: false });
        const start = engine.start;
        engine.start = async (key, input, o) => {
          await start(key, input, o);
          const ip = boundIp(input);
          setTimeout(() => {
            if (refusing.has(ip)) engine.fireState(key, { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
            else engine.fireState(key, { kind: 'online', since: Date.now(), exitIp: ip, country: 'DE' });
          }, 0);
        };
        const ctx = setup({
          targets: [de(servers), freeTier],
          port: { key: 'zoogvpn:DE#1', locationKey: 'zoogvpn:DE', country: 'DE', city: 'Germany', serverIp: '10.0.0.3', state: { kind: 'queued' } },
          portServers: { 'zoogvpn:DE': '10.0.0.3' },
          engine,
          exitIpResults: Array.from({ length: 4 }, (_, i) => ({ ip: ['10.0.0.3', '10.0.0.1', '10.0.0.3', '10.0.0.3'][i], country: 'DE' })),
          depsOverrides: { serverHealth, rotateOnlineTimeoutMs: 2000 },
        });
        return { ...ctx, engine, serverHealth };
      }

      /** Starts the port on 10.0.0.3 and waits for it online: its login is now verified. */
      async function online(ctx: ReturnType<typeof rotateSetup>) {
        await ctx.manager.startPort('zoogvpn:DE#1');
        await vi.waitFor(() => expect(ctx.state.getState().ports[0].state.kind).toBe('online'));
        expect(ctx.state.getState().credentials?.z1?.state).toBe('verified');
        ctx.engine.started.length = 0;
        return ctx;
      }

      it('a refused pick is marked and the port goes back to the server it was on, saying so', async () => {
        const { manager, engine, state, serverHealth } = await online(rotateSetup());
        const result = await manager.rotatePort('zoogvpn:DE#1', '10.0.0.5', { user: true });
        expect(serverHealth.isRefused('z1', '10.0.0.5')).toBe(true);
        expect(engine.started.map((s) => boundIp(s.input))).toEqual(['10.0.0.5', '10.0.0.3']);
        expect(state.getState().ports[0]).toMatchObject({ server: '10.0.0.3', state: { kind: 'online' } });
        expect(result).toMatchObject({ changed: false, noteKey: 'server-refused-returned', refusedServer: '10.0.0.5', landedOn: '10.0.0.3' });
      });

      it('with its old server no longer usable, it moves to the next free usable one instead', async () => {
        const { manager, engine, state, serverHealth } = await online(rotateSetup());
        serverHealth.markDead('z1', '10.0.0.3'); // went down meanwhile
        const result = await manager.rotatePort('zoogvpn:DE#1', '10.0.0.5', { user: true });
        expect(engine.started.map((s) => boundIp(s.input))).toEqual(['10.0.0.5', '10.0.0.1']);
        expect(state.getState().ports[0]).toMatchObject({ server: '10.0.0.1', state: { kind: 'online' } });
        expect(result).toMatchObject({ noteKey: 'server-refused-moved', refusedServer: '10.0.0.5', landedOn: '10.0.0.1' });
      });

      it('fails for good only when no usable server is left in the location', async () => {
        const { manager, engine, state, serverHealth } = await online(rotateSetup(['10.0.0.3', '10.0.0.5']));
        serverHealth.markDead('z1', '10.0.0.3');
        const result = await manager.rotatePort('zoogvpn:DE#1', '10.0.0.5', { user: true });
        await new Promise((r) => setTimeout(r, 10));
        expect(engine.started.map((s) => boundIp(s.input))).toEqual(['10.0.0.5']);
        expect(state.getState().ports[0].state).toMatchObject({ kind: 'failed', reason: 'not-in-plan' });
        expect(result).toMatchObject({ changed: false, noteKey: 'server-refused', refusedServer: '10.0.0.5' });
        expect(result.landedOn).toBeUndefined();
      });

      it('an automatic Change IP that lands on a refusing server returns too, past other refusals', async () => {
        const { manager, engine, state } = await online(rotateSetup(['10.0.0.3', '10.0.0.5', '10.0.0.6']));
        const result = await manager.rotatePort('zoogvpn:DE#1');
        // Round-robin from .3 picks .5 (refused); the failover goes straight back to .3.
        expect(engine.started.map((s) => boundIp(s.input))).toEqual(['10.0.0.5', '10.0.0.3']);
        expect(state.getState().ports[0]).toMatchObject({ server: '10.0.0.3', state: { kind: 'online' } });
        expect(result).toMatchObject({ noteKey: 'server-refused-returned', landedOn: '10.0.0.3' });
      });

      it('the Change IP lock is released while it waits, so a later Change IP works', async () => {
        const { manager } = await online(rotateSetup());
        await manager.rotatePort('zoogvpn:DE#1', '10.0.0.5', { user: true });
        expect((await manager.rotatePort('zoogvpn:DE#1', '10.0.0.2', { user: true })).noteKey).not.toBe('rotate-in-progress');
      });
    });

    describe('health change events (the picker re-reads targets)', () => {
      it('a refusal, a dead mark and a first ok each tell onHealthChanged once their burst settles', async () => {
        const onHealthChanged = vi.fn();
        const { engine, manager } = setup({
          targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }, freeTier],
          port: { enabled: false, state: { kind: 'stopped' } },
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { onHealthChanged, healthChangedDelayMs: 1 },
        });
        await manager.startPort('zoogvpn:nl-ams');
        engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 5, exitIp: '10.0.0.1', country: 'NL' });
        await vi.waitFor(() => expect(onHealthChanged).toHaveBeenCalledTimes(1)); // first ok
        // A later online on the same, already-ok server changes nothing the UI shows.
        engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 6, exitIp: '10.0.0.1', country: 'NL' });
        await new Promise((r) => setTimeout(r, 10));
        expect(onHealthChanged).toHaveBeenCalledTimes(1);
        // A server refusing a port whose login is verified: marked, the port moves on.
        engine.fireState('zoogvpn:nl-ams', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        await vi.waitFor(() => expect(onHealthChanged).toHaveBeenCalledTimes(2));
      });

      it('a hostname resolving onto a refused machine tells it too', async () => {
        const onHealthChanged = vi.fn();
        const serverHealth = createServerHealth();
        serverHealth.noteIp('de7.webunlim.com', '185.177.229.121');
        serverHealth.markRefused('z1', 'de7.webunlim.com');
        const fr: Target = { key: 'zoogvpn:FR', providerId: 'zoogvpn', country: 'FR', city: 'France', label: 'France', servers: ['fr4.webunlim.com'] };
        const { manager } = setup({
          targets: [fr],
          port: { key: 'zoogvpn:FR#1', locationKey: 'zoogvpn:FR', enabled: false, state: { kind: 'stopped' } },
          portServers: {},
          depsOverrides: { serverHealth, onHealthChanged, healthChangedDelayMs: 1, resolveServer: async () => '185.177.229.121' },
        });
        expect(await manager.addPort(fr, 'z1')).toBeUndefined(); // fr4 = de7, refused
        await vi.waitFor(() => expect(onHealthChanged).toHaveBeenCalledTimes(1));
      });
    });

    describe('a mark follows the machine behind every hostname (spec §6.8)', () => {
      // ✅ 2026-10-08: de7.webunlim.com and fr4.webunlim.com both resolve to 185.177.229.121.
      const dns: Record<string, string> = {
        'de7.webunlim.com': '185.177.229.121',
        'fr4.webunlim.com': '185.177.229.121',
        'fr1.webunlim.com': '185.177.229.50',
      };
      const fr: Target = { key: 'zoogvpn:FR', providerId: 'zoogvpn', country: 'FR', city: 'France', label: 'France', servers: ['fr4.webunlim.com', 'fr1.webunlim.com'] };

      function frSetup(serverHealth = createServerHealth()) {
        serverHealth.noteIp('de7.webunlim.com', dns['de7.webunlim.com']);
        serverHealth.markRefused('z1', 'de7.webunlim.com'); // de7 refused the account
        const ctx = setup({
          targets: [fr],
          port: { key: 'zoogvpn:FR#1', locationKey: 'zoogvpn:FR', country: 'FR', city: 'France', enabled: false, state: { kind: 'stopped' } },
          portServers: {},
          engine: fakeEngine({ autoOnline: false }),
          depsOverrides: { serverHealth, resolveServer: async (s) => dns[s] ?? s },
        });
        return { ...ctx, serverHealth };
      }

      it('fr4 is skipped without a handshake once de7 (the same IP) refused the account', async () => {
        const { manager, engine, state } = frSetup();
        await manager.startPort('zoogvpn:FR#1');
        expect(engine.started.map((s) => boundIp(s.input))).toEqual(['185.177.229.50']);
        expect(serverOf(state, 'zoogvpn:FR#1')).toBe('fr1.webunlim.com');
        // The learned hostname → IP is persisted, so the next run knows it before DNS.
        expect(state.getState().serverHealth.ips?.['fr4.webunlim.com']).toBe('185.177.229.121');
      });

      it('adding a port never pins fr4 either, and the Change-IP list shows it refused', async () => {
        const { manager } = frSetup();
        const row = await manager.addPort(fr, 'z1');
        expect(row?.server).toBe('fr1.webunlim.com');
        expect((await manager.listServers(fr)).find((s) => s.server === 'fr4.webunlim.com')?.health).toBe('refused');
      });

      it('a location is "not in plan" once every server refused every account of the provider', async () => {
        const { manager, serverHealth, state } = frSetup();
        expect(manager.locationNotInPlan(fr)).toBe(false); // fr1 not refused
        serverHealth.markRefused('z1', 'fr1.webunlim.com');
        serverHealth.noteIp('fr4.webunlim.com', '185.177.229.121');
        expect(manager.locationNotInPlan(fr)).toBe(true);
        // A second account that has not been refused there may still use it.
        state.setState((s) => ({ ...s, accounts: [...s.accounts, { ...account, id: 'z2', secretRef: 'z2' }] }));
        expect(manager.locationNotInPlan(fr)).toBe(false);
        serverHealth.markRefused('z2', 'fr1.webunlim.com');
        serverHealth.markRefused('z2', 'fr4.webunlim.com');
        expect(manager.locationNotInPlan(fr)).toBe(true);
      });

      it('listServers tags free-tier servers', async () => {
        const { manager } = frSetup();
        const servers = await manager.listServers(freeTier);
        expect(servers).toEqual([expect.objectContaining({ server: 'nl.zgfree.info', freeTier: true })]);
        expect((await manager.listServers(fr)).some((s) => s.freeTier)).toBe(false);
      });

      describe('the Change-IP menu resolves the location first (listServers)', () => {
        function menuSetup(resolve: (s: string) => Promise<string>) {
          const serverHealth = createServerHealth();
          serverHealth.noteIp('de7.webunlim.com', dns['de7.webunlim.com']);
          serverHealth.markRefused('z1', 'de7.webunlim.com');
          const lookups: string[] = [];
          const ctx = setup({
            targets: [fr],
            port: { key: 'zoogvpn:FR#1', locationKey: 'zoogvpn:FR', country: 'FR', city: 'France', server: 'fr1.webunlim.com', serverIp: dns['fr1.webunlim.com'] },
            portServers: {},
            engine: fakeEngine({ autoOnline: false }),
            depsOverrides: {
              serverHealth,
              listResolveTimeoutMs: 50,
              resolveServer: (s) => {
                lookups.push(s);
                return resolve(s);
              },
            },
          });
          return { ...ctx, lookups };
        }

        it("an unresolved twin of a refused machine is listed refused (with its IP) before anyone clicks it", async () => {
          const { manager, engine } = menuSetup(async (s) => dns[s] ?? s);
          const fr4 = (await manager.listServers(fr, 'zoogvpn:FR#1')).find((x) => x.server === 'fr4.webunlim.com');
          expect(fr4).toMatchObject({ ip: '185.177.229.121', health: 'refused' });
          expect(engine.started).toHaveLength(0); // listing never connects
        });

        it('a hostname on a machine another port holds is listed as held', async () => {
          const { manager, state } = menuSetup(async (s) => (s === 'fr4.webunlim.com' ? '185.177.229.50' : (dns[s] ?? s)));
          const fr4 = (await manager.listServers(fr, 'zoogvpn:FR#1')).find((x) => x.server === 'fr4.webunlim.com');
          expect(fr4?.heldBy).toBe('zoogvpn:FR#1'); // fr4 = fr1's machine
          expect(state.getState().ports[0].server).toBe('fr1.webunlim.com');
        });

        it('resolves each hostname once, in parallel, and never waits past its timeout', async () => {
          let release: (ip: string) => void = () => undefined;
          const { manager, lookups } = menuSetup((s) => (s === 'fr4.webunlim.com' ? new Promise<string>((r) => (release = r)) : Promise.resolve(dns[s] ?? s)));
          const t0 = Date.now();
          const [a, b] = await Promise.all([manager.listServers(fr), manager.listServers(fr)]);
          expect(Date.now() - t0).toBeLessThan(1000);
          expect(a.find((x) => x.server === 'fr4.webunlim.com')?.health).toBe('unknown'); // not resolved in time
          expect(b).toEqual(a);
          expect(lookups.filter((s) => s === 'fr4.webunlim.com')).toHaveLength(1); // shared, not doubled
          release('185.177.229.121');
          await vi.waitFor(async () => expect((await manager.listServers(fr)).find((x) => x.server === 'fr4.webunlim.com')?.health).toBe('refused'));
          expect(lookups.filter((s) => s === 'fr4.webunlim.com')).toHaveLength(1); // cached once resolved
        });

        it('a lookup failure leaves the hostname unknown and marks nothing', async () => {
          const { manager } = menuSetup(async (s) => {
            if (s === 'fr4.webunlim.com') throw new Error('ENOTFOUND');
            return dns[s] ?? s;
          });
          expect((await manager.listServers(fr, 'zoogvpn:FR#1')).find((x) => x.server === 'fr4.webunlim.com')).toEqual({ server: 'fr4.webunlim.com', health: 'unknown' });
        });
      });

      it('an explicit Change IP to fr4 is refused up front', async () => {
        const { manager, engine, state } = frSetup();
        state.setState((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p, enabled: true, server: 'fr1.webunlim.com' })) }));
        expect(await manager.rotatePort('zoogvpn:FR#1', 'fr4.webunlim.com', { user: true })).toEqual({ changed: false, noteKey: 'server-unavailable' });
        expect(engine.started).toHaveLength(0);
      });
    });

    describe('HMA per-server auth failover', () => {
      const hmaTarget = (servers: string[]): Target => ({
        key: 'hma:VN-51-HANOI', providerId: 'hma', country: 'VN', city: 'Hanoi', label: 'Hanoi', servers,
      });
      /** `proven`: the account was confirmed online on another server recently. */
      const hmaSetup = (servers: string[], serverHealth = createServerHealth(), proven = true) => {
        if (proven) serverHealth.markOk('z1', '10.9.9.9');
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

      it('stops failing over once every server of the location has refused; nothing restarts it, not even a due retry', async () => {
        const serverHealth = createServerHealth();
        serverHealth.markRefused('z1', '10.9.0.2'); // already refused earlier
        const { manager, engine, state } = hmaSetup(['10.9.0.1', '10.9.0.2'], serverHealth);
        await manager.startPort('hma:VN-51-HANOI#1');
        expect(boundIp(engine.started[0].input)).toBe('10.9.0.1');
        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });

        await new Promise((r) => setTimeout(r, 20));
        expect(engine.started).toHaveLength(1);
        expect(state.getState().ports.find((p) => p.key === 'hma:VN-51-HANOI#1')!.state).toMatchObject({ kind: 'failed', reason: 'auth' });
        expect(engine.stopped).toContain('hma:VN-51-HANOI#1');
        engine.fireRetryDue('hma:VN-51-HANOI#1');
        await manager.startPort('hma:VN-51-HANOI#1'); // an automatic start (resume, app start)
        await new Promise((r) => setTimeout(r, 20));
        expect(engine.started).toHaveLength(1);
        // The user's Start tries again, refused servers included.
        await manager.startPort('hma:VN-51-HANOI#1', { user: true });
        expect(engine.started).toHaveLength(2);
      });

      it('with no proof the device creds work anywhere, an auth failure is a credential problem: nothing marked, no pool walk', async () => {
        const { manager, engine, state, serverHealth } = hmaSetup(['10.9.0.1', '10.9.0.2'], createServerHealth(), false);
        await manager.startPort('hma:VN-51-HANOI#1');
        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        await new Promise((r) => setTimeout(r, 20));
        expect(serverHealth.isUsable('z1', '10.9.0.1')).toBe(true);
        expect(engine.started).toHaveLength(1);
        expect(state.getState().ports[0].state).toMatchObject({ kind: 'failed', reason: 'auth' });
      });

      it('a recent lastOk only on the failing server itself is no proof either', async () => {
        const serverHealth = createServerHealth();
        serverHealth.markOk('z1', '10.9.0.1');
        const { manager, engine } = hmaSetup(['10.9.0.1', '10.9.0.2'], serverHealth, false);
        await manager.startPort('hma:VN-51-HANOI#1');
        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        expect(serverHealth.isRefused('z1', '10.9.0.1')).toBe(false);
      });

      it('another port of the account being online is proof: the server is refused and the port moves', async () => {
        const { manager, engine, state, serverHealth } = hmaSetup(['10.9.0.1', '10.9.0.2', '10.9.0.3'], createServerHealth(), false);
        state.setState((s) => ({
          ...s,
          ports: [
            ...s.ports,
            basePort({ key: 'hma:JP-1#1', locationKey: 'hma:JP-1', providerId: 'hma', proxyPort: 29009, server: '10.8.0.1', state: { kind: 'online', since: 1, exitIp: '10.8.0.1', country: 'JP' } }),
          ],
        }));
        await manager.startPort('hma:VN-51-HANOI#1');
        engine.fireState('hma:VN-51-HANOI#1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
        expect(serverHealth.isRefused('z1', '10.9.0.1')).toBe(true);
        await vi.waitFor(() => expect(engine.started).toHaveLength(2));
      });

      it('credentialsChanged forgets refused/dead marks earned under the old creds, persisted', async () => {
        const serverHealth = createServerHealth();
        serverHealth.markRefused('z1', '10.9.0.1');
        serverHealth.markDead('z1', '10.9.0.2');
        const { manager, state } = hmaSetup(['10.9.0.1', '10.9.0.2'], serverHealth);
        manager.credentialsChanged('z1');
        expect(serverHealth.isUsable('z1', '10.9.0.1')).toBe(true);
        expect(serverHealth.isUsable('z1', '10.9.0.2')).toBe(true);
        expect(state.getState().serverHealth.refused.z1).toBeUndefined();
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
  describe('WireGuard provider safety (spec §6.4)', () => {
    const KEY = 'surfshark:jp-tok#1';
    const ssTargets: Target[] = [
      { key: 'surfshark:jp-tok', providerId: 'surfshark', country: 'JP', city: 'Tokyo', label: 'Tokyo', servers: ['10.1.0.1', '10.1.0.2', '10.1.0.3', '10.1.0.4'] },
    ];
    const ssAccount: Account = { id: 's1', providerId: 'surfshark', label: 'key …abc', meta: {}, secretRef: 's1-secret' };
    const timeout: PortState = { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' };

    function ssSetup(depsOverrides: Partial<PortManagerDeps> = {}) {
      const ctx = setup({
        targets: ssTargets,
        port: { key: KEY, locationKey: 'surfshark:jp-tok', providerId: 'surfshark', accountId: 's1', country: 'JP', city: 'Tokyo', label: 'Tokyo', enabled: false, state: { kind: 'stopped' } },
        portServers: {},
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { attemptLimiter: { take: () => 0 }, ...depsOverrides },
      });
      ctx.secrets.saveSecret('s1-secret', JSON.stringify({ kind: 'wgkey', privateKey: 'k' }));
      ctx.state.setState((st) => ({ ...st, accounts: [account, ssAccount] }));
      return ctx;
    }

    /** One automatic attempt: the due retry restarts the port, which then times out. */
    async function failAgain(ctx: ReturnType<typeof ssSetup>, startedBefore: number): Promise<void> {
      ctx.engine.fireRetryDue(KEY);
      await vi.waitFor(() => expect(ctx.engine.started).toHaveLength(startedBefore + 1));
      ctx.engine.fireState(KEY, timeout);
    }

    const stateOf = (ctx: ReturnType<typeof ssSetup>) => ctx.state.getState().ports.find((p) => p.key === KEY)!.state;

    it('a never-proven key that gets no handshake 3 times in a row is stopped: failed(key-rejected), no retry, lock persisted', async () => {
      const ctx = ssSetup();
      await ctx.manager.startPort(KEY);
      ctx.engine.fireState(KEY, timeout);
      // No immediate hop to the next server: that would be another handshake seconds later.
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.engine.started).toHaveLength(1);
      await failAgain(ctx, 1);
      await failAgain(ctx, 2);
      await vi.waitFor(() => expect(stateOf(ctx)).toMatchObject({ kind: 'failed', reason: 'key-rejected' }));
      expect(ctx.engine.stopped).toContain(KEY);
      expect(Object.keys(ctx.state.getState().wgLockouts)).toEqual(['s1']);
      // The three attempts went to three different servers (each marked dead in turn).
      expect(new Set(ctx.engine.started.map((s) => (s.input.endpoint as { peers: Array<{ address: string }> }).peers[0].address)).size).toBe(3);

      // Automatic starts (a stale due retry, app start) do not touch the provider again.
      ctx.engine.fireRetryDue(KEY);
      await new Promise((r) => setTimeout(r, 10));
      await ctx.manager.startPort(KEY);
      expect(ctx.engine.started).toHaveLength(3);
      expect(stateOf(ctx)).toMatchObject({ kind: 'failed', reason: 'key-rejected' });
      expect(await ctx.manager.rotatePort(KEY)).toEqual({ changed: false, noteKey: 'key-rejected' });
    });

    it('a user Start re-arms the key for exactly one attempt', async () => {
      const ctx = ssSetup({ wgKeyGuard: createWgKeyGuard({ initial: { s1: 1 } }) });
      await ctx.manager.startPort(KEY);
      expect(ctx.engine.started).toHaveLength(0);
      expect(stateOf(ctx)).toMatchObject({ kind: 'failed', reason: 'key-rejected' });

      await ctx.manager.startPort(KEY, { user: true });
      expect(ctx.engine.started).toHaveLength(1);
      ctx.engine.fireState(KEY, timeout);
      await vi.waitFor(() => expect(stateOf(ctx)).toMatchObject({ kind: 'failed', reason: 'key-rejected' }));
    });

    it('a handshake clears the lock and the count', async () => {
      const ctx = ssSetup();
      await ctx.manager.startPort(KEY);
      ctx.engine.fireState(KEY, timeout);
      await failAgain(ctx, 1);
      ctx.engine.fireRetryDue(KEY);
      await vi.waitFor(() => expect(ctx.engine.started).toHaveLength(3));
      ctx.engine.fireState(KEY, { kind: 'verifying', since: 1 }); // first /delay 200
      ctx.engine.fireState(KEY, timeout); // a later drop: says nothing about the key
      await failAgain(ctx, 3);
      await failAgain(ctx, 4);
      await new Promise((r) => setTimeout(r, 10));
      expect(stateOf(ctx)).toMatchObject({ kind: 'retrying' });
    });

    it('an account that has worked before is never locked; it just backs off', async () => {
      const serverHealth = createServerHealth();
      serverHealth.markOk('s1', '10.1.0.9');
      const ctx = ssSetup({ serverHealth });
      await ctx.manager.startPort(KEY);
      ctx.engine.fireState(KEY, timeout);
      for (let n = 1; n < 5; n++) await failAgain(ctx, n);
      await new Promise((r) => setTimeout(r, 10));
      expect(stateOf(ctx)).toMatchObject({ kind: 'retrying', reasonKey: 'timeout' });
      expect(ctx.state.getState().wgLockouts).toEqual({});
    });

    it('new credentials drop the lock', async () => {
      const ctx = ssSetup({ wgKeyGuard: createWgKeyGuard({ initial: { s1: 1 } }) });
      ctx.manager.credentialsChanged('s1');
      expect(ctx.state.getState().wgLockouts).toEqual({});
      await ctx.manager.startPort(KEY);
      expect(ctx.engine.started).toHaveLength(1);
    });

    it('OpenVPN accounts are unaffected: no lock however often a server times out', async () => {
      const { manager, engine, state } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1', '10.0.0.2'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { attemptLimiter: { take: () => 0 } },
      });
      await manager.startPort('zoogvpn:nl-ams');
      engine.fireState('zoogvpn:nl-ams', timeout);
      await new Promise((r) => setTimeout(r, 10));
      expect(state.getState().wgLockouts).toEqual({});
      expect(engine.started).toHaveLength(2); // the immediate failover still happens for OpenVPN
    });
  });

  describe('NordVPN (NordLynx) gets the same provider safety (spec §5.5, §6.4)', () => {
    const NKEY = 'nordvpn:VN-HANOI#1';
    const nTargets: Target[] = [
      { key: 'nordvpn:VN-HANOI', providerId: 'nordvpn', country: 'VN', city: 'Hanoi', label: 'Vietnam — Hanoi', servers: ['10.2.0.1', '10.2.0.2', '10.2.0.3', '10.2.0.4'] },
    ];
    const nAccount: Account = { id: 'n1', providerId: 'nordvpn', label: 'key …abc', meta: {}, secretRef: 'n1-secret' };
    const timeout: PortState = { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' };

    function nSetup(depsOverrides: Partial<PortManagerDeps> = {}) {
      const ctx = setup({
        targets: nTargets,
        port: { key: NKEY, locationKey: 'nordvpn:VN-HANOI', providerId: 'nordvpn', accountId: 'n1', country: 'VN', city: 'Hanoi', label: 'Hanoi', enabled: false, state: { kind: 'stopped' } },
        portServers: {},
        engine: fakeEngine({ autoOnline: false }),
        depsOverrides: { attemptLimiter: { take: () => 0 }, ...depsOverrides },
      });
      ctx.secrets.saveSecret('n1-secret', JSON.stringify({ kind: 'wgkey', privateKey: 'k' }));
      ctx.state.setState((st) => ({ ...st, accounts: [account, nAccount] }));
      return ctx;
    }
    const stateOf = (ctx: ReturnType<typeof nSetup>) => ctx.state.getState().ports.find((p) => p.key === NKEY)!.state;

    it('an unproven key that gets no handshake 3 times in a row is locked: failed(key-rejected)', async () => {
      const ctx = nSetup();
      await ctx.manager.startPort(NKEY);
      ctx.engine.fireState(NKEY, timeout);
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.engine.started).toHaveLength(1); // no immediate hop, as for Surfshark
      for (const n of [1, 2]) {
        ctx.engine.fireRetryDue(NKEY);
        await vi.waitFor(() => expect(ctx.engine.started).toHaveLength(n + 1));
        ctx.engine.fireState(NKEY, timeout);
      }
      await vi.waitFor(() => expect(stateOf(ctx)).toMatchObject({ kind: 'failed', reason: 'key-rejected' }));
      expect(Object.keys(ctx.state.getState().wgLockouts)).toEqual(['n1']);
      await ctx.manager.startPort(NKEY);
      expect(ctx.engine.started).toHaveLength(3);
    });

    describe('a session exit IP (spec §5.5): fixed while connected, may change on reconnect', () => {
      it('a different exit after a reconnect is just the new exit: no failover, no error', async () => {
        const ctx = nSetup();
        await ctx.manager.startPort(NKEY);
        ctx.engine.fireState(NKEY, { kind: 'online', since: 1, exitIp: '10.2.0.22', country: 'VN' });
        ctx.engine.fireState(NKEY, timeout);
        ctx.engine.fireState(NKEY, { kind: 'online', since: 2, exitIp: '10.2.0.15', country: 'VN' });
        await new Promise((r) => setTimeout(r, 10));
        expect(stateOf(ctx)).toMatchObject({ kind: 'online', exitIp: '10.2.0.15' });
        expect(ctx.engine.started).toHaveLength(1);
        expect(ctx.state.getState().ports.find((p) => p.key === NKEY)!.server).toBe('10.2.0.1');
      });

      it("an exit a server had in an earlier session does not make it look like another port's server", async () => {
        const ctx = nSetup();
        await ctx.manager.startPort(NKEY);
        ctx.engine.fireState(NKEY, { kind: 'online', since: 1, exitIp: '10.2.0.40', country: 'VN' });
        // #1 moves on to 10.2.0.3; 10.2.0.1's last exit (.40) is history now.
        ctx.state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === NKEY ? { ...p, server: '10.2.0.3', serverIp: '10.2.0.3' } : p)) }));
        ctx.engine.fireState(NKEY, { kind: 'online', since: 2, exitIp: '10.2.0.66', country: 'VN' });
        // #2's session on 10.2.0.2 happens to draw .40.
        const k2 = 'nordvpn:VN-HANOI#2';
        ctx.state.setState((s) => ({
          ...s,
          ports: [...s.ports, basePort({ key: k2, locationKey: 'nordvpn:VN-HANOI', providerId: 'nordvpn', accountId: 'n1', proxyPort: 29002, server: '10.2.0.2', serverIp: '10.2.0.2', state: { kind: 'stopped' } })],
        }));
        ctx.engine.fireState(k2, { kind: 'online', since: 3, exitIp: '10.2.0.40', country: 'VN' });
        expect(ctx.state.getState().ports.find((p) => p.key === k2)!.state).toMatchObject({ kind: 'online' });
        // Free: 10.2.0.1 and 10.2.0.4 (#1 holds .3, #2 holds .2).
        expect(ctx.manager.freeServerCount(nTargets[0])).toBe(2);
      });
    });

    it('its engine starts take from the per-account attempt budget', async () => {
      const timers: number[] = [];
      const ctx = nSetup({
        attemptLimiter: createAttemptLimiter({ now: () => 0, perMinute: 1 }),
        scheduleRetry: (ms) => {
          timers.push(ms);
          return () => undefined;
        },
      });
      await ctx.manager.startPort(NKEY);
      await ctx.manager.startPort(NKEY);
      expect(ctx.engine.started).toHaveLength(1);
      expect(stateOf(ctx)).toMatchObject({ kind: 'retrying', reasonKey: 'rate-limited' });
      expect(timers).toEqual([60_000]);
    });
  });
});
