import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DelayResult, ExitIpResult, LogSignal, PortState, RenderInput } from '../../shared/contracts';
import { sampleWireguardEndpoint } from '../engine/__fixtures__/endpoints';
import type { PidEntry } from '../engine/pid-registry';
import type { ExitInfo } from '../engine/supervisor';
import { createRealEngine, reapOrphanedEngines, type EngineProcessLike, type PortHealthLike } from './engine-adapter';
import { PortInUseError } from './ports';

function fakeEngineProcess(pid: number | undefined = 111): EngineProcessLike & {
  startedConfigs: string[];
  stop: ReturnType<typeof vi.fn>;
  emitLog: (line: string) => void;
  emitExit: (info: ExitInfo) => void;
} {
  const logCbs = new Set<(line: string) => void>();
  const exitCbs = new Set<(info: ExitInfo) => void>();
  const startedConfigs: string[] = [];
  const stopFn = vi.fn(async () => undefined);
  return {
    pid,
    logs: [],
    startedConfigs,
    start(config: string) {
      startedConfigs.push(config);
    },
    stop: stopFn,
    onLog(cb: (line: string) => void) {
      logCbs.add(cb);
      return () => logCbs.delete(cb);
    },
    onExit(cb: (info: ExitInfo) => void) {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },
    emitLog(line: string) {
      for (const cb of logCbs) cb(line);
    },
    emitExit(info: ExitInfo) {
      for (const cb of exitCbs) cb(info);
    },
  };
}

function fakePortHealth(): PortHealthLike & {
  started: number;
  stopped: number;
  fedLog: LogSignal[];
  fedDelay: DelayResult['code'][];
  fedExit: Array<number | null>;
  fedVerify: Array<{ ok: boolean; info?: { exitIp: string; country: string } }>;
  setState: (s: PortState) => void;
  fireRetryDue: () => void;
} {
  const stateChangeCbs = new Set<(s: PortState) => void>();
  const retryDueCbs = new Set<() => void>();
  let state: PortState = { kind: 'queued' };
  const self = {
    get state() {
      return state;
    },
    started: 0,
    stopped: 0,
    fedLog: [] as LogSignal[],
    fedDelay: [] as DelayResult['code'][],
    fedExit: [] as Array<number | null>,
    fedVerify: [] as Array<{ ok: boolean; info?: { exitIp: string; country: string } }>,
    start() {
      self.started++;
      self.setState({ kind: 'connecting', since: 1 });
    },
    stop() {
      self.stopped++;
      self.setState({ kind: 'stopped' });
    },
    feedLog(sig: LogSignal) {
      self.fedLog.push(sig);
    },
    feedDelay(code: DelayResult['code']) {
      self.fedDelay.push(code);
    },
    feedEstablishedThenVerify(ok: boolean, info?: { exitIp: string; country: string }) {
      self.fedVerify.push({ ok, info });
      if (ok && info) self.setState({ kind: 'online', since: 2, exitIp: info.exitIp, country: info.country });
    },
    feedExit(code: number | null) {
      self.fedExit.push(code);
    },
    onStateChange(cb: (s: PortState) => void) {
      stateChangeCbs.add(cb);
      return () => stateChangeCbs.delete(cb);
    },
    onRetryDue(cb: () => void) {
      retryDueCbs.add(cb);
      return () => retryDueCbs.delete(cb);
    },
    setState(s: PortState) {
      state = s;
      for (const cb of stateChangeCbs) cb(s);
    },
    fireRetryDue() {
      for (const cb of retryDueCbs) cb();
    },
  };
  return self;
}

function sampleInput(port: number, proxyAuth?: { username: string; password: string }): RenderInput {
  return {
    endpoint: sampleWireguardEndpoint,
    listen: { host: '127.0.0.1', port, proxyAuth },
    clash: { port: 0, secret: '' }, // the adapter overrides this itself
  };
}

/** Occupies a real TCP port on both 127.0.0.1 and 0.0.0.0 so `isPortFree` reports it
 * taken, to exercise the `PortInUseError` path deterministically. */
function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

describe('engine adapter (reviewer item 6: real Engine/PortHealth wiring)', () => {
  const recordedPids: Array<{ registryPath: string; key: string; entry: any }> = [];
  const removedPids: Array<{ registryPath: string; key: string }> = [];

  afterEach(() => {
    recordedPids.length = 0;
    removedPids.length = 0;
  });

  function setup(opts: { exitIpResult?: ExitIpResult | Error; delayResult?: DelayResult } = {}) {
    const processes: ReturnType<typeof fakeEngineProcess>[] = [];
    const healths: ReturnType<typeof fakePortHealth>[] = [];
    const delayCalls: Array<{ clashPort: number; secret: string; tag: string }> = [];
    const exitIpCalls: Array<{ proxyPort: number; auth: unknown }> = [];
    let scheduledCb: (() => void) | undefined;

    const engine = createRealEngine({
      registryPath: '/tmp/pf-fake-registry.json',
      binPath: '/bin/fake-singbox',
      createEngineProcess: () => {
        const p = fakeEngineProcess();
        processes.push(p);
        return p;
      },
      createPortHealth: () => {
        const h = fakePortHealth();
        healths.push(h);
        return h;
      },
      schedule: (_ms, cb) => {
        scheduledCb = cb;
        return () => {
          scheduledCb = undefined;
        };
      },
      delayProbeFn: async (clashPort, secret, tag) => {
        delayCalls.push({ clashPort, secret, tag });
        return opts.delayResult ?? { code: 200, ms: 5 };
      },
      exitIpProbeFn: async (proxyPort, probeOpts) => {
        exitIpCalls.push({ proxyPort, auth: probeOpts?.auth });
        if (opts.exitIpResult instanceof Error) throw opts.exitIpResult;
        return opts.exitIpResult ?? { ip: '9.9.9.9', country: 'NL' };
      },
      recordPidFn: async (registryPath, key, entry) => {
        recordedPids.push({ registryPath, key, entry });
      },
      removePidFn: async (registryPath, key) => {
        removedPids.push({ registryPath, key });
      },
    });

    return { engine, processes, healths, delayCalls, exitIpCalls, fireDelayTick: () => scheduledCb?.() };
  }

  it('start() renders+validates the config, spawns via the process factory, and starts PortHealth', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45201));
    expect(processes).toHaveLength(1);
    expect(processes[0].startedConfigs).toHaveLength(1);
    const config = JSON.parse(processes[0].startedConfigs[0]);
    expect(config.route.final).toBe('block'); // sanity: a real, invariant-passing config
    expect(healths[0].started).toBe(1);
  });

  it('records the pid after starting', async () => {
    const { engine } = setup();
    await engine.start('k1', sampleInput(45202));
    expect(recordedPids).toHaveLength(1);
    expect(recordedPids[0].key).toBe('k1');
    expect(recordedPids[0].entry.pid).toBe(111);
  });

  it('onLog -> classifyLog -> PortHealth.feedLog', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45203));
    processes[0].emitLog('some line, INFO tunnel established to 1.2.3.4:51820');
    expect(healths[0].fedLog).toEqual(['established']);
  });

  it('an unrecognised log line is not fed to PortHealth', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45204));
    processes[0].emitLog('just some ordinary info line');
    expect(healths[0].fedLog).toEqual([]);
  });

  it('reaching `verifying` triggers an exit-IP probe with the configured proxy auth, reported back via feedEstablishedThenVerify', async () => {
    const auth = { username: 'proxy', password: 'pw' };
    const { engine, healths, exitIpCalls } = setup({ exitIpResult: { ip: '7.7.7.7', country: 'NL' } });
    await engine.start('k1', sampleInput(45205, auth));
    healths[0].setState({ kind: 'verifying', since: 2 });
    await vi.waitFor(() => expect(healths[0].fedVerify).toHaveLength(1));
    expect(exitIpCalls[0]).toEqual({ proxyPort: 45205, auth });
    expect(healths[0].fedVerify[0]).toEqual({ ok: true, info: { exitIp: '7.7.7.7', country: 'NL' } });
  });

  it('a failed exit-IP probe during verifying reports feedEstablishedThenVerify(false)', async () => {
    const { engine, healths } = setup({ exitIpResult: new Error('probe failed') });
    await engine.start('k1', sampleInput(45206));
    healths[0].setState({ kind: 'verifying', since: 2 });
    await vi.waitFor(() => expect(healths[0].fedVerify).toHaveLength(1));
    expect(healths[0].fedVerify[0]).toEqual({ ok: false, info: undefined });
  });

  it('onExit -> PortHealth.feedExit, unless we are the ones who called stop()', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45207));
    processes[0].emitExit({ code: 1, signal: null });
    expect(healths[0].fedExit).toEqual([1]);
  });

  it('an exit after our own stop() is not fed to PortHealth as a failure', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45208));
    await engine.stop('k1');
    processes[0].emitExit({ code: 0, signal: null });
    expect(healths[0].fedExit).toEqual([]);
  });

  it('onRetryDue respawns the process with the exact same rendered config', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45209));
    expect(processes[0].startedConfigs).toHaveLength(1);
    healths[0].fireRetryDue();
    expect(processes[0].startedConfigs).toHaveLength(2);
    expect(processes[0].startedConfigs[0]).toBe(processes[0].startedConfigs[1]);
  });

  it('the periodic /delay poll feeds PortHealth.feedDelay with the stored clash port/secret', async () => {
    const { engine, healths, delayCalls, fireDelayTick } = setup({ delayResult: { code: 504 } });
    await engine.start('k1', sampleInput(45210));
    fireDelayTick();
    await vi.waitFor(() => expect(healths[0].fedDelay).toEqual([504]));
    expect(delayCalls[0].tag).toBe('ep');
  });

  it('probe(key) hits clash_api with the same stored clash port/secret as the delay poll', async () => {
    const { engine, delayCalls } = setup({ delayResult: { code: 200, ms: 7 } });
    await engine.start('k1', sampleInput(45211));
    const result = await engine.probe('k1');
    expect(result).toEqual({ code: 200, ms: 7 });
    expect(delayCalls).toHaveLength(1);
  });

  it('probe(key) for an unknown key returns an error DelayResult rather than throwing', async () => {
    const { engine } = setup();
    const result = await engine.probe('nope');
    expect(result).toEqual({ code: 'error', message: expect.stringContaining('nope') });
  });

  it('getLogs(key) serves the process ring, empty for an unknown key', async () => {
    const { engine, processes } = setup();
    await engine.start('k1', sampleInput(45212));
    processes[0].logs.push('line 1', 'line 2');
    expect(engine.getLogs('k1')).toEqual(['line 1', 'line 2']);
    expect(engine.getLogs('nope')).toEqual([]);
  });

  it('onStateChange(key, state) fires with the key for every PortHealth transition', async () => {
    const { engine, healths } = setup();
    const seen: Array<{ key: string; state: PortState }> = [];
    engine.onStateChange((key, state) => seen.push({ key, state }));
    await engine.start('k1', sampleInput(45213));
    healths[0].setState({ kind: 'online', since: 3, exitIp: '1.1.1.1', country: 'NL' });
    expect(seen.map((s) => s.key)).toEqual(['k1', 'k1']); // start() itself -> connecting, then our explicit online
    expect(seen[1].state).toMatchObject({ kind: 'online', exitIp: '1.1.1.1' });
  });

  it('stop() tears everything down: cancels the delay poll, stops PortHealth and the process, removes the pid', async () => {
    const { engine, processes, healths, fireDelayTick } = setup();
    await engine.start('k1', sampleInput(45214));
    await engine.stop('k1');
    expect(healths[0].stopped).toBe(1);
    expect(processes[0].stop.mock.calls).toHaveLength(1);
    expect(removedPids).toEqual([{ registryPath: '/tmp/pf-fake-registry.json', key: 'k1' }]);
    // the delay poll was cancelled: firing the (now-stale) tick is a no-op, not a crash
    expect(() => fireDelayTick()).not.toThrow();
  });

  it('stop() on an unknown key is a harmless no-op', async () => {
    const { engine } = setup();
    await expect(engine.stop('nope')).resolves.toBeUndefined();
  });

  it('starting the same key again tears down the previous process/health first', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45215));
    await engine.start('k1', sampleInput(45216));
    expect(processes).toHaveLength(2);
    expect(healths[0].stopped).toBe(1); // the first health was stopped before the second started
    expect(healths[1].started).toBe(1);
  });

  it('throws PortInUseError when the proxy port itself is already bound by something else', async () => {
    const occupied = await occupyPort();
    const { engine } = setup();
    try {
      await expect(engine.start('k1', sampleInput(occupied.port))).rejects.toThrow(PortInUseError);
    } finally {
      await occupied.close();
    }
  });
});

describe('reapOrphanedEngines (spec §6.3: bootstrap kills stale processes from a crash)', () => {
  it('delegates to the real pid-registry reapOrphans against the given registry path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-engine-adapter-reap-'));
    const registryPath = join(dir, 'pids.json');
    const { recordPid } = await import('../engine/pid-registry');
    // process.pid is always "alive", so recordPid'ing ourselves under a DIFFERENT exe
    // path means reapOrphans finds it alive but the exe doesn't match -> not reaped.
    const entry: PidEntry = { pid: process.pid, exe: '/definitely/not/our/exe', startedAt: Date.now() };
    await recordPid(registryPath, 'k1', entry);
    const killed = await reapOrphanedEngines(registryPath);
    expect(killed).toBe(0); // exe mismatch: not touched, and we're still here to say so
    rmSync(dir, { recursive: true, force: true });
  });
});
