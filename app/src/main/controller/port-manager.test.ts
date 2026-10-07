import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, EndpointSpec, ExitIpResult, PortRow, Provider, Target } from '../../shared/contracts';
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

function fakeEngine(): Engine & { started: Array<{ key: string; config: string }>; stopped: string[] } {
  const started: Array<{ key: string; config: string }> = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    renderConfig: (input) => JSON.stringify(input),
    start: async (key, config) => {
      started.push({ key, config });
    },
    stop: async (key) => {
      stopped.push(key);
    },
    probe: async () => ({ code: 200, ms: 10 }),
  };
}

/** Queue of results/errors returned in order, one per call to `probe`. */
function fakeExitIpProber(results: Array<ExitIpResult | Error>): ExitIpProber {
  const queue = [...results];
  return {
    probe: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('fakeExitIpProber: no more results queued');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function fakeAllocator(): PortAllocator {
  let aux = 30000;
  return {
    allocate: async (preferred) => preferred ?? 29001,
    allocateAux: async () => aux++,
    release: () => undefined,
  };
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
  }) {
    const state = createStateStore(join(dir, 'state.json'));
    const secrets = fakeSecretStore();
    secrets.saveSecret('z1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
    state.setState((s) => ({
      ...s,
      accounts: [account],
      ports: [basePort(opts.port)],
      portServers: opts.portServers ?? { 'zoogvpn:nl-ams': '10.0.0.1' },
    }));
    const engine = fakeEngine();
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
    };
    return { manager: createPortManager(deps), state, engine, secrets };
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
    it('starts an existing port: renders config, starts the engine, records the server and goes online', async () => {
      const { manager, state, engine } = setup({
        targets: [{ key: 'zoogvpn:nl-ams', providerId: 'zoogvpn', country: 'NL', city: 'Amsterdam', label: 'Amsterdam', servers: ['10.0.0.1'] }],
        port: { enabled: false, state: { kind: 'stopped' } },
        exitIpResults: [{ ip: '5.5.5.5', country: 'NL' }],
      });
      await manager.startPort('zoogvpn:nl-ams');
      expect(engine.started).toHaveLength(1);
      expect(state.getState().ports[0].state).toMatchObject({ kind: 'online', exitIp: '5.5.5.5' });
      expect(state.getState().ports[0].enabled).toBe(true);
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
  });
});
