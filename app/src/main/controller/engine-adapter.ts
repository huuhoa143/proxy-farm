import { randomBytes } from 'node:crypto';
import { ENDPOINT_TAG, type DelayResult, type LogSignal, type PortState, type RenderInput } from '../../shared/contracts';
import { assertConfigInvariants } from '../engine/invariants';
import { allocatePort, isPortFree } from '../engine/ports';
import { reapOrphans, recordPid, removePid, type PidEntry, type ReapOrphansOptions } from '../engine/pid-registry';
import { renderConfig } from '../engine/render-config';
import { EngineProcess, type EngineProcessOptions, type ExitInfo } from '../engine/supervisor';
import { singboxPath } from '../engine/singbox-path';
import { delayProbe } from '../health/delay';
import { probeExitIp } from '../health/exit-ip';
import { classifyLog } from '../health/signals';
import { PortHealth, type PortHealthOptions } from '../health/state-machine';
import { PortInUseError, type Engine } from './ports';

const CLASH_AUX_BASE = 40000;

/** The slice of `EngineProcess`'s public API this adapter needs — a structural
 * interface (not the class itself) so tests can inject a plain-object fake; a class
 * with private fields can't otherwise satisfy a class-typed parameter. */
export interface EngineProcessLike {
  readonly pid: number | undefined;
  readonly logs: string[];
  start(configJson: string): void;
  stop(): Promise<void>;
  onLog(cb: (line: string) => void): () => void;
  onExit(cb: (info: ExitInfo) => void): () => void;
}

/** The slice of `PortHealth`'s public API this adapter needs (see `EngineProcessLike`). */
export interface PortHealthLike {
  readonly state: PortState;
  start(): void;
  stop(): void;
  feedLog(sig: LogSignal): void;
  feedDelay(code: DelayResult['code']): void;
  feedEstablishedThenVerify(exitOk: boolean, info?: { exitIp: string; country: string; latencyMs?: number }): void;
  feedExit(code: number | null): void;
  onStateChange(cb: (state: PortState) => void): () => void;
  onRetryDue(cb: () => void): () => void;
}

export interface CreateRealEngineOptions {
  /** Where the pid registry JSON file lives (spec §6.3). */
  registryPath: string;
  /** @default singboxPath() */
  binPath?: string;
  /** Fed into every port's `PortHealth` (spec `Settings.giveUpAfter`). @default 0 (never) */
  giveUpAfter?: number;
  /** How often to poll clash_api `/delay` while a port is active. @default 30_000 (§6.4) */
  delayPollMs?: number;
  /** Injectable for tests. */
  createEngineProcess?: (opts?: EngineProcessOptions) => EngineProcessLike;
  createPortHealth?: (opts?: PortHealthOptions) => PortHealthLike;
  schedule?: (ms: number, cb: () => void) => () => void;
  delayProbeFn?: typeof delayProbe;
  exitIpProbeFn?: typeof probeExitIp;
  classifyLogFn?: typeof classifyLog;
  recordPidFn?: typeof recordPid;
  removePidFn?: typeof removePid;
  /** Injectable clock, used only for the pid registry's `startedAt`. */
  now?: () => number;
}

/**
 * Kills any stale `sing-box` processes left behind by a crash of the previous session
 * (spec §6.3). The bootstrap (app `whenReady`, before any port is started) must call
 * this once — it is NOT called automatically by `createRealEngine`/`start`, since
 * starting ports one-by-one is not the right time to reap a whole previous session.
 * Resolves the number of processes killed.
 */
export function reapOrphanedEngines(registryPath: string, opts?: ReapOrphansOptions): Promise<number> {
  return reapOrphans(registryPath, opts);
}

function defaultSchedule(ms: number, cb: () => void): () => void {
  const timer = setInterval(cb, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

interface PortEntry {
  process: EngineProcessLike;
  health: PortHealthLike;
  clashPort: number;
  clashSecret: string;
  proxyPort: number;
  auth?: { username: string; password: string };
  cancelDelayPoll: () => void;
  unsubscribe: Array<() => void>;
  /** True once `stop()` has been called for this key, so a resulting process exit is
   * not mistaken for an unexpected crash and re-fed into `PortHealth` as a failure. */
  stopping: boolean;
}

/**
 * Binds the real engine/health modules (merged from `v2/engine`) behind the `Engine`
 * port (reviewer item 6): one `EngineProcess` + `PortHealth` pair per port key,
 * `onLog` -> `classifyLog` -> `PortHealth.feedLog`, `onExit` -> `PortHealth.feedExit`,
 * a periodic `/delay` poll -> `PortHealth.feedDelay`, and — once `PortHealth` reaches
 * `verifying` — an exit-IP probe reported back via `feedEstablishedThenVerify`.
 * `PortHealth` owns the resulting `PortState`; callers observe it via `onStateChange`.
 */
export function createRealEngine(options: CreateRealEngineOptions): Engine {
  const binPath = options.binPath ?? singboxPath();
  const delayPollMs = options.delayPollMs ?? 30_000;
  const schedule = options.schedule ?? defaultSchedule;
  const doDelayProbe = options.delayProbeFn ?? delayProbe;
  const doExitIpProbe = options.exitIpProbeFn ?? probeExitIp;
  const doClassifyLog = options.classifyLogFn ?? classifyLog;
  const doRecordPid = options.recordPidFn ?? recordPid;
  const doRemovePid = options.removePidFn ?? removePid;
  const now = options.now ?? Date.now;

  const entries = new Map<string, PortEntry>();
  const stateChangeCbs = new Set<(key: string, state: PortState) => void>();

  async function teardown(key: string, entry: PortEntry): Promise<void> {
    entry.stopping = true;
    entry.cancelDelayPoll();
    for (const unsub of entry.unsubscribe) unsub();
    entry.health.stop();
    await entry.process.stop();
    await doRemovePid(options.registryPath, key);
  }

  async function start(key: string, input: RenderInput): Promise<void> {
    const existing = entries.get(key);
    if (existing) await teardown(key, existing);

    // The proxy port itself is the one bind failure that's terminal, not retried with a
    // substitute (spec §6.2: `failed('port-in-use')`, "Move to another port"). Auxiliary
    // (clash) ports, by contrast, just get a different candidate via `allocatePort`'s own
    // scan — that retry is already built into `allocatePort` below.
    if (!(await isPortFree(input.listen.port))) {
      throw new PortInUseError(input.listen.port);
    }

    const clashPort = await allocatePort({ base: CLASH_AUX_BASE });
    const clashSecret = randomBytes(16).toString('hex');
    const finalInput: RenderInput = { ...input, clash: { port: clashPort, secret: clashSecret } };
    const config = renderConfig(finalInput);
    assertConfigInvariants(JSON.parse(config));

    const engineProcess = (options.createEngineProcess ?? ((o) => new EngineProcess(o)))({ binPath });
    const health = (options.createPortHealth ?? ((o) => new PortHealth(o)))({ giveUpAfter: options.giveUpAfter });

    const entry: PortEntry = {
      process: engineProcess,
      health,
      clashPort,
      clashSecret,
      proxyPort: input.listen.port,
      auth: input.listen.proxyAuth,
      cancelDelayPoll: () => undefined,
      unsubscribe: [],
      stopping: false,
    };
    entries.set(key, entry);

    entry.unsubscribe.push(health.onStateChange((state) => {
      for (const cb of stateChangeCbs) cb(key, state);
    }));

    // Once sing-box signals "established"/the first 200, PortHealth moves to
    // `verifying`; that's this adapter's cue to confirm the exit IP actually changed
    // and report back, per spec §6.4.
    entry.unsubscribe.push(
      health.onStateChange((state) => {
        if (state.kind !== 'verifying') return;
        void doExitIpProbe(entry.proxyPort, { auth: entry.auth })
          .then((exit) => health.feedEstablishedThenVerify(true, { exitIp: exit.ip, country: exit.country }))
          .catch(() => health.feedEstablishedThenVerify(false));
      }),
    );

    entry.unsubscribe.push(
      health.onRetryDue(() => {
        // Re-spawn with the exact same rendered config; a genuinely different server
        // is a `rotatePort` (a fresh `start()` call under this or another key), not a retry.
        engineProcess.start(config);
      }),
    );

    entry.unsubscribe.push(
      engineProcess.onLog((line) => {
        const signal = doClassifyLog(line);
        if (signal) health.feedLog(signal);
      }),
    );

    entry.unsubscribe.push(
      engineProcess.onExit((info: ExitInfo) => {
        if (entry.stopping) return; // our own stop(), not a crash
        health.feedExit(info.code);
      }),
    );

    entry.cancelDelayPoll = schedule(delayPollMs, () => {
      void doDelayProbe(entry.clashPort, entry.clashSecret, ENDPOINT_TAG)
        .then((result: DelayResult) => health.feedDelay(result.code))
        .catch(() => undefined);
    });

    health.start();
    engineProcess.start(config);

    if (engineProcess.pid !== undefined) {
      const entryInfo: PidEntry = { pid: engineProcess.pid, exe: binPath, startedAt: now() };
      await doRecordPid(options.registryPath, key, entryInfo);
    }
  }

  async function stop(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    await teardown(key, entry);
  }

  async function probe(key: string): Promise<DelayResult> {
    const entry = entries.get(key);
    if (!entry) return { code: 'error', message: `probe: no running engine for "${key}"` };
    return doDelayProbe(entry.clashPort, entry.clashSecret, ENDPOINT_TAG);
  }

  function getLogs(key: string): string[] {
    return entries.get(key)?.process.logs ?? [];
  }

  function onStateChange(cb: (key: string, state: PortState) => void): () => void {
    stateChangeCbs.add(cb);
    return () => stateChangeCbs.delete(cb);
  }

  return { start, stop, probe, getLogs, onStateChange };
}
