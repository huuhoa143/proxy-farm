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
  fedDelayMs: Array<number | undefined>;
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
    fedDelayMs: [] as Array<number | undefined>,
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
    feedDelay(code: DelayResult['code'], ms?: number) {
      self.fedDelay.push(code);
      self.fedDelayMs.push(ms);
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

  function setup(opts: { exitIpResult?: ExitIpResult | Error; delayResult?: DelayResult; isPortFree?: (port: number) => Promise<boolean> } = {}) {
    const processes: ReturnType<typeof fakeEngineProcess>[] = [];
    const healths: ReturnType<typeof fakePortHealth>[] = [];
    const healthOpts: Array<{ initialAttempt?: number } | undefined> = [];
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
      createPortHealth: (o) => {
        healthOpts.push(o);
        const h = fakePortHealth();
        healths.push(h);
        return h;
      },
      initialProbeDelaysMs: [],
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
      isPortFreeFn: opts.isPortFree,
      recordPidFn: async (registryPath, key, entry) => {
        recordedPids.push({ registryPath, key, entry });
      },
      removePidFn: async (registryPath, key) => {
        removedPids.push({ registryPath, key });
      },
    });

    return { engine, processes, healths, healthOpts, delayCalls, exitIpCalls, fireDelayTick: () => scheduledCb?.() };
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

  it('reviewer I-2: exit-IP probe keeps failing but /delay is 200 -> online with unknown geo, not an endless retry', async () => {
    // Tunnel genuinely up (clash_api /delay returns 200), every IP-echo service
    // unreachable: the port must become usable rather than oscillating forever.
    const { engine, healths, exitIpCalls } = setup({ exitIpResult: new Error('probe failed'), delayResult: { code: 200, ms: 5 } });
    await engine.start('k1', sampleInput(45206));
    healths[0].setState({ kind: 'verifying', since: 2 });
    await vi.waitFor(() => expect(healths[0].fedVerify).toHaveLength(1));
    expect(healths[0].fedVerify[0]).toEqual({ ok: true, info: { exitIp: 'unknown', country: 'unknown', latencyMs: 5 } }); // the /delay round trip
    expect(exitIpCalls.length).toBe(3); // bounded by MAX_EXIT_IP_ATTEMPTS, not infinite
  });

  it('reviewer I-2: exit-IP probe fails AND /delay is not 200 -> still a retry (a truly dead tunnel is not force-onlined)', async () => {
    const { engine, healths } = setup({ exitIpResult: new Error('probe failed'), delayResult: { code: 504 } });
    await engine.start('k1', sampleInput(45216));
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

  it('onRetryDue respawns the process with the exact same rendered config (no external retry handler)', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45209));
    expect(processes[0].startedConfigs).toHaveLength(1);
    healths[0].fireRetryDue();
    await vi.waitFor(() => expect(processes[0].startedConfigs).toHaveLength(2));
    expect(processes[0].startedConfigs[0]).toBe(processes[0].startedConfigs[1]);
  });

  it('reviewer I-1: with an onRetryDue listener, a due retry is delegated by key and NOT self-respawned in place', async () => {
    const { engine, processes, healths } = setup();
    const retried: string[] = [];
    engine.onRetryDue?.((key) => retried.push(key));
    await engine.start('k1', sampleInput(45229));
    expect(processes[0].startedConfigs).toHaveLength(1);
    healths[0].fireRetryDue();
    // The listener (in practice port-manager) is told to re-resolve + re-start this key;
    // the adapter must not also respawn its stale config, which would race onto the port.
    await vi.waitFor(() => expect(retried).toEqual(['k1']));
    expect(processes[0].startedConfigs).toHaveLength(1);
  });

  it('integration fix: onRetryDue stops a still-running child before respawning, and that exit is not fed as a crash', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45208));
    const p = processes[0];
    let running = true;
    p.start = (config: string) => {
      if (running) throw new Error('EngineProcess.start: already started');
      running = true;
      p.startedConfigs.push(config);
    };
    p.stop.mockImplementation(async () => {
      running = false;
      p.emitExit({ code: 0, signal: null });
    });
    healths[0].fireRetryDue();
    await vi.waitFor(() => expect(p.startedConfigs).toHaveLength(2));
    expect(p.stop).toHaveBeenCalledTimes(1);
    expect(healths[0].fedExit).toEqual([]);
  });

  it('start(key, input, {attempt}) hands the carried-over back-off attempt to the new PortHealth', async () => {
    const { engine, healthOpts } = setup();
    await engine.start('k1', sampleInput(45240), { attempt: 4 });
    expect(healthOpts[0]).toMatchObject({ initialAttempt: 4 });
  });

  it('stops the child while the port waits out a back-off, so it sends no handshakes meanwhile; that exit is not a crash', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45241));
    const p = processes[0];
    p.stop.mockImplementation(async () => {
      p.emitExit({ code: 0, signal: null });
    });
    healths[0].setState({ kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' });
    expect(p.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(healths[0].fedExit).toEqual([]));
  });

  it('also stops the child on failed(auth); an online port keeps its child', async () => {
    const { engine, processes, healths } = setup();
    await engine.start('k1', sampleInput(45242));
    healths[0].setState({ kind: 'online', since: 1, exitIp: '1.2.3.4', country: 'NL' });
    expect(processes[0].stop).not.toHaveBeenCalled();
    healths[0].setState({ kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 });
    expect(processes[0].stop).toHaveBeenCalledTimes(1);
  });

  it('reviewer item 6: onRetryDue re-records the pid on every respawn, not just the first spawn', async () => {
    const { engine, healths } = setup();
    await engine.start('k1', sampleInput(45230));
    expect(recordedPids).toHaveLength(1);
    healths[0].fireRetryDue();
    await vi.waitFor(() => expect(recordedPids).toHaveLength(2));
    expect(recordedPids[1].key).toBe('k1');
  });

  describe('reviewer item 5: bind-error reallocation/termination', () => {
    it('a PROXY port bind collision is terminal: reports failed(port-in-use) and quiesces PortHealth rather than retrying', async () => {
      const { engine, processes, healths } = setup();
      const seen: Array<{ key: string; state: PortState }> = [];
      engine.onStateChange((key, state) => seen.push({ key, state }));
      await engine.start('k1', sampleInput(45231));

      processes[0].emitLog('FATAL[0000] start: listen tcp4 127.0.0.1:45231: bind: address already in use');
      processes[0].emitExit({ code: 1, signal: null });
      await vi.waitFor(() => expect(seen.some((s) => s.state.kind === 'failed')).toBe(true));

      const failedEvent = seen.find((s) => s.state.kind === 'failed')!;
      expect(failedEvent.state).toMatchObject({ kind: 'failed', reason: 'port-in-use' });
      // Quiesced, not fed a generic exit: PortHealth never gets to apply its own
      // connectivity backoff/retry to a bind collision that it has no vocabulary for.
      expect(healths[0].stopped).toBe(1);
      expect(healths[0].fedExit).toEqual([]);
      await vi.waitFor(() => expect(removedPids).toEqual([{ registryPath: '/tmp/pf-fake-registry.json', key: 'k1' }]));

      // reviewer M-1: the torn-down entry is removed from the map, so it no longer
      // reports as a running engine (nor keeps counting its ports in allClaimedPorts).
      expect(await engine.probe('k1')).toEqual({ code: 'error', message: 'probe: no running engine for "k1"' });
    });

    it('a clash_api (aux) port bind collision reallocates and retries immediately, re-recording the pid, without touching PortHealth', async () => {
      const { engine, processes, healths, delayCalls } = setup();
      await engine.start('k1', sampleInput(45232));
      await engine.probe('k1'); // learn the (randomly-allocated) current clash port
      const oldClashPort = delayCalls[0].clashPort;

      processes[0].emitLog(`FATAL[0000] start: listen tcp4 127.0.0.1:${oldClashPort}: bind: address already in use`);
      processes[0].emitExit({ code: 1, signal: null });
      await vi.waitFor(() => expect(processes[0].startedConfigs).toHaveLength(2));

      expect(recordedPids).toHaveLength(2); // respawn re-recorded the pid (reviewer item 6)
      expect(healths[0].fedExit).toEqual([]); // not surfaced to PortHealth as a failure

      await engine.probe('k1');
      const newClashPort = delayCalls[delayCalls.length - 1].clashPort;
      expect(newClashPort).not.toBe(oldClashPort);
    });

    it('gives up reallocating after MAX_CLASH_BIND_RETRIES and lets PortHealth see an ordinary exit', async () => {
      const { engine, processes, healths } = setup();
      await engine.start('k1', sampleInput(45233));

      // Keep "colliding" on the clash port past the retry cap.
      for (let i = 0; i < 6; i++) {
        const configsBefore = processes[0].startedConfigs.length;
        processes[0].emitLog('FATAL[0000] start: listen tcp4 127.0.0.1:49999: bind: address already in use');
        processes[0].emitExit({ code: 1, signal: null });
        // eslint-disable-next-line no-await-in-loop
        await vi.waitFor(() => expect(processes[0].startedConfigs.length > configsBefore || healths[0].fedExit.length > 0).toBe(true));
      }
      expect(healths[0].fedExit.length).toBeGreaterThan(0); // eventually handed to PortHealth
    });

    describe('reviewer round 3, item 1: the bind-error regex must not grab a timestamp', () => {
      it('a real timestamped PROXY-port bind-failure line -> terminal failed(port-in-use)', async () => {
        // Fake the pre-spawn port check (true) so `start` proceeds to the spawn; the
        // bind failure under test arrives as a sing-box LOG line, not the pre-check.
        // Keeps the test hermetic — it no longer binds the real default port 29001.
        const { engine, processes } = setup({ isPortFree: async () => true });
        const seen: Array<{ key: string; state: PortState }> = [];
        engine.onStateChange((key, state) => seen.push({ key, state }));
        await engine.start('k1', sampleInput(29001));

        // Realistic sing-box output: timestamp-prefixed, with an earlier `HH:MM:SS` that
        // an unanchored regex could mistake for the colliding port (`34` from `12:34:56`).
        processes[0].emitLog(
          '+0700 2026-10-08 12:34:56 FATAL[0000] start service: start inbound/mixed[in]: listen tcp4 127.0.0.1:29001: bind: address already in use',
        );
        processes[0].emitExit({ code: 1, signal: null });
        await vi.waitFor(() => expect(seen.some((s) => s.state.kind === 'failed')).toBe(true));
        expect(seen.find((s) => s.state.kind === 'failed')!.state).toMatchObject({ kind: 'failed', reason: 'port-in-use' });
      });

      it('a real timestamped CLASH-port bind-failure line -> reallocate+retry branch', async () => {
        const { engine, processes, healths } = setup();
        await engine.start('k1', sampleInput(29002));

        // Real clash_api collision message shape, also timestamp-prefixed.
        processes[0].emitLog(
          '+0700 2026-10-08 12:34:56 FATAL[0000] finish-start clash server: external controller listen error: listen tcp 127.0.0.1:41501: bind: address already in use',
        );
        processes[0].emitExit({ code: 1, signal: null });
        await vi.waitFor(() => expect(processes[0].startedConfigs).toHaveLength(2));
        expect(healths[0].fedExit).toEqual([]); // reallocated+retried, not surfaced as a failure
      });
    });

    describe('reviewer round 3, item 3: a race during the in-flight reallocation must not resurrect/corrupt the process', () => {
      it('stop() racing the in-flight reallocation leaves the process NOT respawned', async () => {
        const { engine, processes } = setup();
        await engine.start('k1', sampleInput(45250));
        processes[0].emitLog('FATAL[0000] start: listen tcp4 127.0.0.1:49999: bind: address already in use');
        processes[0].emitExit({ code: 1, signal: null }); // kicks off the async reallocation (await allocatePort ...)
        await engine.stop('k1'); // races it: sets entry.stopping = true while the allocation is still in flight
        await new Promise((r) => setTimeout(r, 50)); // let the in-flight reallocation resolve past the guard
        expect(processes[0].startedConfigs).toHaveLength(1); // never respawned after the stop
      });

      it('a fresh start() under the same key racing the in-flight reallocation is never stepped on', async () => {
        const { engine, processes } = setup();
        await engine.start('k1', sampleInput(45251));
        processes[0].emitLog('FATAL[0000] start: listen tcp4 127.0.0.1:49999: bind: address already in use');
        processes[0].emitExit({ code: 1, signal: null });
        await engine.start('k1', sampleInput(45252)); // races it: a NEW entry now owns the 'k1' key
        await new Promise((r) => setTimeout(r, 50));
        expect(processes[0].startedConfigs).toHaveLength(1); // the OLD process: never got a reallocation respawn
        expect(processes[1].startedConfigs).toHaveLength(1); // the NEW process: just its own fresh spawn
      });
    });
  });

  it('the periodic /delay poll feeds PortHealth.feedDelay with the stored clash port/secret', async () => {
    const { engine, healths, delayCalls, fireDelayTick } = setup({ delayResult: { code: 504 } });
    await engine.start('k1', sampleInput(45210));
    fireDelayTick();
    await vi.waitFor(() => expect(healths[0].fedDelay).toEqual([504]));
    expect(delayCalls[0].tag).toBe('ep');
  });

  it('the /delay poll hands a 200\'s round trip to PortHealth as the latency', async () => {
    const { engine, healths, fireDelayTick } = setup({ delayResult: { code: 200, ms: 37 } });
    await engine.start('k1', sampleInput(45213));
    fireDelayTick();
    await vi.waitFor(() => expect(healths[0].fedDelayMs).toEqual([37]));
    expect(healths[0].fedDelay).toEqual([200]);
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

  it('reviewer item 10: getLogs keeps the last known ring after stop(), rather than going blank', async () => {
    const { engine, processes } = setup();
    await engine.start('k1', sampleInput(45234));
    processes[0].logs.push('line 1', 'line 2');
    await engine.stop('k1');
    expect(engine.getLogs('k1')).toEqual(['line 1', 'line 2']);
  });

  it('reviewer item 10: getLogs keeps the last known ring after a rotate-away (start under a new key), for the OLD key', async () => {
    const { engine, processes } = setup();
    await engine.start('k1', sampleInput(45235));
    processes[0].logs.push('old line');
    await engine.stop('k1'); // rotate's own stop(oldKey) before start(finalKey, ...)
    await engine.start('k2', sampleInput(45236));
    expect(engine.getLogs('k1')).toEqual(['old line']);
    expect(engine.getLogs('k2')).toEqual([]);
  });

  it('reviewer item 10: a fresh start() under the SAME key clears the stale last-known ring', async () => {
    const { engine, processes } = setup();
    await engine.start('k1', sampleInput(45237));
    processes[0].logs.push('first run');
    await engine.stop('k1');
    expect(engine.getLogs('k1')).toEqual(['first run']);
    await engine.start('k1', sampleInput(45238));
    expect(engine.getLogs('k1')).toEqual([]); // the new process's own (empty) ring, not the old snapshot
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
