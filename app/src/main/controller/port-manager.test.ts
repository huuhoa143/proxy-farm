import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, EndpointSpec, ExitIpResult, PortRow, PortState, Provider, RenderInput, Target } from '../../shared/contracts';
import type { SecretStore } from '../store/secrets';
import { createStateStore } from '../store/state';
import { createPortManager, type PortManagerDeps } from './port-manager';
import type { Engine, ExitIpProber, PortAllocator } from './ports';

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
} {
  const autoOnline = opts.autoOnline ?? true;
  const started: Array<{ key: string; input: RenderInput }> = [];
  const stopped: string[] = [];
  const stateChangeCbs = new Set<(key: string, state: PortState) => void>();
  function fireState(key: string, state: PortState): void {
    for (const cb of stateChangeCbs) cb(key, state);
  }
  return {
    started,
    stopped,
    fireState,
    start: async (key, input) => {
      started.push({ key, input });
      if (autoOnline) {
        const timer = setTimeout(() => fireState(key, { kind: 'online', since: Date.now(), exitIp: '0.0.0.0', country: 'XX' }), 0);
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

function basePort(overrides: Partial<PortRow> = {}): PortRow {
  return {
    key: 'zoogvpn:nl-ams',
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
    portServers?: Record<string, string>;
    engine?: Engine;
    depsOverrides?: Partial<PortManagerDeps>;
  }) {
    const secrets = fakeSecretStore();
    secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
    const state = createStateStore(join(dir, 'state.json'), secrets);
    state.setState((s) => ({
      ...s,
      accounts: [account],
      ports: [basePort(opts.port)],
      portServers: opts.portServers ?? { 'zoogvpn:nl-ams': '10.0.0.1' },
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
      expect(state.getState().portServers['zoogvpn:nl-ams']).toBe('10.0.0.2');
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
      expect(rows[0].key).toBe('zoogvpn:nl-rot');
      expect(rows[0].city).toBe('Rotterdam');
      expect(state.getState().portServers['zoogvpn:nl-rot']).toBe('10.0.0.9');
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

  describe('startPort / stopPort / removePort', () => {
    it('starts an existing port: builds the render input, starts the engine, and records the server', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started).toHaveLength(1);
      expect(engine.started[0].key).toBe('zoogvpn:nl-ams');
      expect(state.getState().portServers['zoogvpn:nl-ams']).toBe('10.0.0.1');
      expect(state.getState().ports[0].enabled).toBe(true);
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
      expect(state.getState().portServers['zoogvpn:nl-ams']).toBeUndefined();
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

  describe('ensurePort', () => {
    it('creates a new row with an allocated, persistent proxy port', async () => {
      const { manager, state } = setup({ targets: [] });
      const target: Target = { key: 'zoogvpn:de-ber', providerId: 'zoogvpn', country: 'DE', city: 'Berlin', label: 'Berlin', servers: ['1.2.3.4'] };
      const row = await manager.ensurePort(target, 'z1');
      expect(row.key).toBe('zoogvpn:de-ber');
      expect(row.proxyPort).toBeGreaterThan(0);
      expect(state.getState().ports.some((p) => p.key === 'zoogvpn:de-ber')).toBe(true);
    });

    it('returns the existing row instead of creating a duplicate', async () => {
      const { manager } = setup({ targets: [] });
      const target: Target = { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] };
      const row = await manager.ensurePort(target, 'z1');
      expect(row.proxyPort).toBe(29001);
    });

    it('never duplicates a proxy port already held by another row (reviewer item 5)', async () => {
      const { manager, state, allocator } = setup({ targets: [] });
      // the existing row from setup() already holds 29001
      const target: Target = { key: 'zoogvpn:de-ber', providerId: 'zoogvpn', country: 'DE', city: 'Berlin', label: 'Berlin', servers: ['1.2.3.4'] };
      const row = await manager.ensurePort(target, 'z1');
      expect(row.proxyPort).not.toBe(29001);
      expect(allocator.allocateCalls[0].taken).toEqual(new Set([29001]));
      const ports = state.getState().ports.map((p) => p.proxyPort);
      expect(new Set(ports).size).toBe(ports.length); // no duplicates
    });

    it('serializes concurrent ensurePort calls so they never race onto the same port', async () => {
      const { manager } = setup({ targets: [] });
      // An allocator with an artificial delay: without serialization, two concurrent
      // ensurePort calls would both read "29001 is taken, nothing else is" before
      // either had allocated, and could both return the same next free port. (`manager`
      // from `setup()` above is unused here; this test rebuilds its own with the slow
      // allocator below.)
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
        state,
        secrets,
        engine: fakeEngine(),
        providers: { get: () => fakeProvider([]) },
        exitIp: fakeExitIpProber([]),
        allocator: slowAllocator,
      });
      const t1: Target = { key: 'zoogvpn:de-ber', providerId: 'zoogvpn', country: 'DE', city: 'Berlin', label: 'Berlin', servers: [] };
      const t2: Target = { key: 'zoogvpn:fr-par', providerId: 'zoogvpn', country: 'FR', city: 'Paris', label: 'Paris', servers: [] };
      const [r1, r2] = await Promise.all([m2.ensurePort(t1, 'z1'), m2.ensurePort(t2, 'z1')]);
      expect(r1.proxyPort).not.toBe(r2.proxyPort);
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
      expect(engine.started.map((s) => s.key)).toEqual(['zoogvpn:nl-rot']);

      // the running process is now addressable ONLY via the final key
      await manager.stopPort('zoogvpn:nl-rot');
      expect(engine.stopped).toEqual(['zoogvpn:nl-ams', 'zoogvpn:nl-rot']);
    });

    it('critical 2: never falls back onto a location that already has its own row', async () => {
      const targets: Target[] = [
        { key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] },
        { key: 'zoogvpn:nl-rot', providerId: 'zoogvpn', country: 'NL', city: 'Rotterdam', label: 'Rotterdam', servers: ['10.0.0.9'] },
      ];
      const { manager, state } = setup({ targets });
      // nl-rot already has its own row (its own engine process) — rotate must not steal it
      state.setState((s) => ({ ...s, ports: [...s.ports, basePort({ key: 'zoogvpn:nl-rot', city: 'Rotterdam', proxyPort: 29002 })] }));
      const result = await manager.rotatePort('zoogvpn:nl-ams');
      expect(result).toEqual({ changed: false, noteKey: 'no-server' });
    });
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
        ports: [basePort({ enabled: false, state: { kind: 'stopped' } })],
        portServers: { 'zoogvpn:nl-ams': '10.0.0.1' },
      }));
      const m2 = createPortManager({
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
      expect(state.getState().portServers['zoogvpn:nl-ams']).toBe('C');
      await manager.rotatePort('zoogvpn:nl-ams'); // C -> A (wraps)
      expect(state.getState().portServers['zoogvpn:nl-ams']).toBe('A');
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
      expect(state.getState().refusals.online.z1?.['zoogvpn:nl-ams']).toBeTypeOf('number');
    });

    it('a zoogvpn port reaching failed(auth) records an auth failure, persisted into AppState.refusals', async () => {
      const { state, engine } = setup({ targets: [] });
      engine.fireState('zoogvpn:nl-ams', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
      expect(state.getState().refusals.failures.z1?.['zoogvpn:nl-ams']).toBeTypeOf('number');
    });

    it('a non-online state clears a previously recorded online marker', async () => {
      const { state, engine } = setup({ targets: [] });
      engine.fireState('zoogvpn:nl-ams', { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL' });
      expect(state.getState().refusals.online.z1?.['zoogvpn:nl-ams']).toBeTypeOf('number');
      engine.fireState('zoogvpn:nl-ams', { kind: 'stopped' });
      expect(state.getState().refusals.online.z1?.['zoogvpn:nl-ams']).toBeUndefined();
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
        ports: [basePort()],
        refusals: { failures: { z1: seedTimestamps }, online: {} },
      }));
      const engine = fakeEngine();
      const m2 = createPortManager({
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
      expect(state.getState().refusals.online.z1?.['zoogvpn:nl-ams']).toBeTypeOf('number');
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
      const row = state.getState().ports.find((p) => p.key === 'zoogvpn:nl-rot');
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
          basePort({ key: 'zoogvpn:nl-bogus1', city: 'Bogus1', proxyPort: 29001 }),
          basePort({
            key: 'zoogvpn:nl-bogus2',
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
        state,
        secrets,
        engine,
        providers: { get: () => slowProvider },
        exitIp,
        allocator: fakeAllocator(),
      });

      const [r1, r2] = await Promise.all([manager.rotatePort('zoogvpn:nl-bogus1'), manager.rotatePort('zoogvpn:nl-bogus2')]);

      const keys = state.getState().ports.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length); // never a duplicate key
      expect(keys).toContain('zoogvpn:nl-rot'); // the one real alt WAS claimed by someone

      // Exactly one of the two could claim the only available alt ('zoogvpn:nl-rot');
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
});
