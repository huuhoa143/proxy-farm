import { randomBytes } from 'node:crypto';
import { ENDPOINT_TAG, type DelayResult, type LogSignal, type PortState, type RenderInput } from '../../shared/contracts';
import { assertConfigInvariants } from '../engine/invariants';
import { allocatePort, isPortFree } from '../engine/ports';
import { reapOrphans, recordPid, removePid, type ReapOrphansOptions } from '../engine/pid-registry';
import { renderConfig } from '../engine/render-config';
import { EngineProcess, type EngineProcessOptions, type ExitInfo } from '../engine/supervisor';
import { singboxPath } from '../engine/singbox-path';
import { delayProbe, FETCH_TIMEOUT_MS } from '../health/delay';
import { probeExitIp } from '../health/exit-ip';
import { classifyLog } from '../health/signals';
import { PortHealth, type PortHealthOptions } from '../health/state-machine';
import { PortInUseError, type Engine, type EngineStartOptions } from './ports';

const CLASH_AUX_BASE = 40000;

/** Heuristic, LOCAL to this adapter (reviewer item 5) — deliberately NOT added to
 * `health/signals.ts`'s shared `classifyLog`, which is PortHealth's own vocabulary for
 * connectivity signals, not an engine-process-management concern. Matches sing-box's Go
 * `net` bind-failure message (e.g. `listen tcp4 127.0.0.1:29001: bind: address already
 * in use`) and pulls out the colliding port number so the caller can tell whether it was
 * the PROXY port (terminal, spec §6.2) or the auxiliary clash_api port (reallocate and
 * retry) that got stolen out from under us between render time and spawn time.
 *
 * Anchored on sing-box's OWN `listen tcp<N> <host>:<port>: bind: ...` phrasing
 * (reviewer round 3, item 1): real log lines are timestamp-prefixed (e.g. `+0700
 * 2026-10-08 12:34:56 FATAL[0000] ...`), and an EARLIER, unanchored version of this
 * regex (`/:(\d{2,5})\b[^\n]*address already in use/i`) matched leftmost-first, so it
 * grabbed `34` out of the `12:34:56` timestamp instead of the real colliding port —
 * requiring the `listen tcp…` prefix and the `: bind:` suffix immediately after the
 * port rules that out. */
const BIND_ERROR_PORT_RE = /listen tcp\d?\s+\S*:(\d+):\s*bind:\s*address already in use/i;

function detectBindErrorPort(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const match = line.match(BIND_ERROR_PORT_RE);
  return match ? Number(match[1]) : undefined;
}

/** Caps how many times a clash_api (auxiliary) port bind-collision is reallocated and
 * retried in a row before giving up and letting the exit be fed to `PortHealth` as an
 * ordinary failure (its own backoff then applies) — this is ephemeral port-allocation
 * noise, not a connectivity problem, so it is NOT subject to PortHealth's own backoff by
 * default, but must still not spin tight forever in some genuinely pathological case
 * (e.g. almost the entire ephemeral range externally occupied). */
const MAX_CLASH_BIND_RETRIES = 5;

/** How many times the exit-IP probe is retried, back to back, while `verifying` before
 * the adapter stops treating unverifiable geo as a tunnel failure (reviewer I-2). If all
 * attempts fail yet `/delay` still returns 200 — the tunnel is genuinely up, only the
 * IP-echo services are unreachable — the port is reported `online` with an unknown exit
 * IP/country instead of oscillating connecting→verifying→retrying forever. A tunnel that
 * is actually dead fails these AND the `/delay` check, so it still drops to a retry. */
const MAX_EXIT_IP_ATTEMPTS = 3;

/** Adapter-side backstop on every clash_api health request, a little above the probe's
 * own client timeout, so even a probe implementation that never settles cannot stall
 * the poll (an unanswered poll is a failed probe, never an endless await). */
const DEFAULT_PROBE_DEADLINE_MS = FETCH_TIMEOUT_MS + 2000;

/** Polls in a row the controller API has not answered at all before the engine is
 * considered hung and force-killed (see `unresponsiveKillAfter`). */
const DEFAULT_UNRESPONSIVE_KILL_AFTER = 3;

/** The slice of `EngineProcess`'s public API this adapter needs — a structural
 * interface (not the class itself) so tests can inject a plain-object fake; a class
 * with private fields can't otherwise satisfy a class-typed parameter. */
export interface EngineProcessLike {
  readonly pid: number | undefined;
  readonly logs: string[];
  start(configJson: string): void;
  stop(): Promise<void>;
  /** Force-terminates a hung process (SIGTERM, SIGKILL after `graceMs`); the exit is
   * reported through `onExit` like a crash. */
  kill(graceMs?: number): Promise<void>;
  onLog(cb: (line: string) => void): () => void;
  onExit(cb: (info: ExitInfo) => void): () => void;
}

/** The slice of `PortHealth`'s public API this adapter needs (see `EngineProcessLike`). */
export interface PortHealthLike {
  readonly state: PortState;
  start(): void;
  stop(): void;
  feedLog(sig: LogSignal): void;
  feedDelay(code: DelayResult['code'], ms?: number): void;
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
  /** Fed into every port's `PortHealth` (spec `Settings.giveUpAfter`). @default 0 (never).
   * May be a getter so a Settings change is read live on each retry tick (reviewer M-5);
   * passed straight through to `PortHealth`. */
  giveUpAfter?: number | (() => number);
  /** How often to poll clash_api `/delay` while a port is active. @default 30_000 (§6.4) */
  delayPollMs?: number;
  /**
   * Extra one-shot `/delay` probes after each spawn, while the port is still
   * `connecting` (integration fix): WireGuard never logs "established", so without these
   * a healthy WireGuard port sat in `connecting` until the first 30 s poll.
   * @default [1500, 4000, 8000, 15000]
   */
  initialProbeDelaysMs?: number[];
  /** Hard cap on every clash_api health request made here; past it the request counts
   * as unanswered. @default 10_000 (the probe's own 8 s client timeout + 2 s) */
  probeDeadlineMs?: number;
  /** Consecutive polls the controller API leaves unanswered before the engine is treated
   * as hung and killed (SIGTERM, then SIGKILL after `killGraceMs`); its exit then goes
   * through the normal crash → back-off → restart path. @default 3 */
  unresponsiveKillAfter?: number;
  /** SIGTERM → SIGKILL grace when killing a hung engine. @default the supervisor's (3 s) */
  killGraceMs?: number;
  /** Injectable for tests. */
  createEngineProcess?: (opts?: EngineProcessOptions) => EngineProcessLike;
  createPortHealth?: (opts?: PortHealthOptions) => PortHealthLike;
  schedule?: (ms: number, cb: () => void) => () => void;
  delayProbeFn?: typeof delayProbe;
  exitIpProbeFn?: typeof probeExitIp;
  classifyLogFn?: typeof classifyLog;
  /** Injectable proxy-port availability check. @default the real `isPortFree` (binds the
   * port to test it). Tests inject a fake so they never depend on a real free port. */
  isPortFreeFn?: typeof isPortFree;
  /** Injectable clash_api port scan. @default the real `allocatePort` (binds to test). */
  allocatePortFn?: typeof allocatePort;
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
  /** Mutable (reviewer item 5): reassigned in place when a clash_api bind collision is
   * reallocated — the in-flight `/delay` poll closure reads these fields fresh on every
   * tick, so mutating them here is enough to redirect it with no extra wiring. */
  clashPort: number;
  clashSecret: string;
  proxyPort: number;
  auth?: { username: string; password: string };
  /** The caller-supplied `RenderInput` as given to `start(key, input)`, BEFORE this
   * adapter overrides `.clash` — kept so a bind-error reallocation (or any future
   * respawn needing a full re-render) can rebuild a config without the caller having to
   * call `start` again (reviewer item 5). */
  callerInput: RenderInput;
  /** The most recently rendered+validated config actually sent to `process.start()`
   * (reviewer item 6): `onRetryDue`'s respawn and the bind-error respawn both read THIS,
   * never a value closed over at the original `start()` call, so either path always
   * resends whatever was last valid — including a clash-port reallocation that happened
   * in between. */
  lastConfig: string;
  /** Last redacted log line seen for this entry's CURRENT process instance (reviewer
   * item 5): sing-box's bind-failure message is the line immediately preceding its
   * exit, so this is what `detectBindErrorPort` is run against from `onExit`. */
  lastLogLine?: string;
  /** How many times IN A ROW a clash_api bind collision has been reallocated+retried
   * for this entry (reviewer item 5) — reset whenever the process starts cleanly and
   * reaches any state other than an immediate bind-error exit. */
  bindErrorRetries: number;
  cancelDelayPoll: () => void;
  unsubscribe: Array<() => void>;
  /** True once `stop()` has been called for this key, so a resulting process exit is
   * not mistaken for an unexpected crash and re-fed into `PortHealth` as a failure. */
  stopping: boolean;
  /** True while a retry is stopping the old child before respawning it: that exit is
   * ours, not a crash, and must not be fed to PortHealth. */
  respawning?: boolean;
  /** True while the child is being stopped because the port entered a back-off: that
   * exit is ours too. */
  quiescing?: boolean;
  /** The pid recorded in the registry for the current child, until that child exits. */
  spawnedPid?: number;
  /** A `/delay` poll is outstanding: the next tick is skipped rather than stacked. */
  probeInFlight?: boolean;
  /** Polls in a row that clash_api left unanswered (hard timeout), for the hung-engine
   * watchdog. Reset by any answer, even an error one. */
  unansweredPolls: number;
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
  const initialProbeDelaysMs = options.initialProbeDelaysMs ?? [1500, 4000, 8000, 15000];
  const schedule = options.schedule ?? defaultSchedule;
  const doDelayProbe = options.delayProbeFn ?? delayProbe;
  const doExitIpProbe = options.exitIpProbeFn ?? probeExitIp;
  const doClassifyLog = options.classifyLogFn ?? classifyLog;
  const doIsPortFree = options.isPortFreeFn ?? isPortFree;
  const doAllocatePort = options.allocatePortFn ?? allocatePort;
  const doRecordPid = options.recordPidFn ?? recordPid;
  const doRemovePid = options.removePidFn ?? removePid;
  const now = options.now ?? Date.now;
  const probeDeadlineMs = options.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const unresponsiveKillAfter = Math.max(1, options.unresponsiveKillAfter ?? DEFAULT_UNRESPONSIVE_KILL_AFTER);

  /** Every clash_api health request goes through here: it never rejects and never waits
   * longer than `probeDeadlineMs`, whatever the underlying probe does. */
  function delayWithDeadline(entry: PortEntry): Promise<DelayResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<DelayResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ code: 'error', timedOut: true, message: `clash_api did not answer within ${probeDeadlineMs} ms` }),
        probeDeadlineMs,
      );
    });
    const request = doDelayProbe(entry.clashPort, entry.clashSecret, ENDPOINT_TAG).catch(
      (err: unknown): DelayResult => ({ code: 'error', message: `delay probe failed: ${err instanceof Error ? err.message : String(err)}` }),
    );
    return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
  }

  const entries = new Map<string, PortEntry>();
  const stateChangeCbs = new Set<(key: string, state: PortState) => void>();
  // When anything is subscribed here (in practice `port-manager`), a due retry is
  // delegated to it to re-resolve + re-select a server (reviewer I-1) instead of this
  // adapter respawning its own stale `lastConfig` in place. With no subscriber the
  // adapter falls back to the in-place respawn (keeps standalone use + existing tests).
  const retryDueCbs = new Set<(key: string) => void>();
  // Survives `entries.delete(key)` (reviewer item 10): `getLogs` falls back to this so a
  // UI still open on a just-stopped/rotated-away port keeps showing its last known ring
  // instead of suddenly going blank.
  const lastKnownLogs = new Map<string, string[]>();

  /** Records the entry's freshly spawned child in the pid registry (spec §6.3). Called
   * on EVERY spawn (reviewer item 6), so a respawn's new pid replaces the old one. */
  function recordSpawn(key: string, entry: PortEntry): Promise<void> {
    const pid = entry.process.pid;
    if (pid === undefined) return Promise.resolve();
    entry.spawnedPid = pid;
    return doRecordPid(options.registryPath, key, { pid, exe: binPath, startedAt: now() });
  }

  async function teardown(key: string, entry: PortEntry): Promise<void> {
    entry.stopping = true;
    entry.cancelDelayPoll();
    for (const unsub of entry.unsubscribe) unsub();
    entry.health.stop();
    lastKnownLogs.set(key, entry.process.logs);
    await entry.process.stop();
    await doRemovePid(options.registryPath, key);
  }

  /** Ports a `start` in flight has picked but not yet registered in `entries`: without
   * them, two overlapping starts (a credential probe while ports start, two ports of a
   * bulk start) both saw the same port free and handed it to two sing-box processes,
   * and the second one died on its bind. One reservation per start call. */
  const reserved = new Set<{ key: string; ports: Set<number> }>();

  /** Every proxy/clash port currently claimed by ANY entry or start in flight (reviewer
   * item 5): the `taken` set a clash-port allocation must scan around, same spirit as
   * `port-manager.ts`'s `takenProxyPorts()` for the proxy side. `exceptKey`'s own
   * claims are left out (a restart of a key reuses its proxy port). */
  function allClaimedPorts(exceptKey?: string): Set<number> {
    const taken = new Set<number>();
    for (const [k, e] of entries) {
      if (k === exceptKey) continue;
      taken.add(e.proxyPort);
      taken.add(e.clashPort);
    }
    for (const r of reserved) if (r.key !== exceptKey) for (const port of r.ports) taken.add(port);
    return taken;
  }

  /** A clash_api port no entry or start in flight holds, reserved for `key` before any
   * other start can pick it: re-picked if one took it while this one was scanning. */
  async function reserveClashPort(reservation: { key: string; ports: Set<number> }): Promise<number> {
    for (;;) {
      const port = await doAllocatePort({ base: CLASH_AUX_BASE, taken: allClaimedPorts(reservation.key) });
      // Synchronous from here: no other start can run between this check and the add.
      if (allClaimedPorts(reservation.key).has(port)) continue;
      reservation.ports.add(port);
      return port;
    }
  }

  /**
   * Reacts to an unexpected process exit whose last log line was sing-box reporting a
   * bind failure (reviewer item 5 — a race between render time and spawn time: some
   * other process grabbed the port out from under us). Distinguishes which port
   * collided:
   * - the PROXY port: terminal, per spec §6.2 ("the one bind failure that's not
   *   retried with a new port") — quiesce `PortHealth` and report `failed('port-in-use')`
   *   directly, since `PortHealth` has no first-class reason for "the OS port was stolen
   *   mid-session" to map a generic `feedExit` onto.
   * - the auxiliary clash_api port: not a real connectivity problem, so it's reallocated
   *   (excluding every port any entry currently holds) and retried immediately, up to
   *   `MAX_CLASH_BIND_RETRIES` times before falling back to an ordinary `feedExit`.
   */
  async function handleBindError(key: string, entry: PortEntry, collidedPort: number): Promise<void> {
    if (collidedPort === entry.proxyPort) {
      await teardown(key, entry);
      // Drop the torn-down entry from the map (reviewer M-1): unlike `stop()`, this path
      // never did, so its proxyPort/clashPort kept being counted by `allClaimedPorts()`
      // and `entries.get(key)` still returned a dead entry. Guard against a fresh entry
      // having replaced it during the `await teardown` above.
      if (entries.get(key) === entry) entries.delete(key);
      const failedState: PortState = { kind: 'failed', reason: 'port-in-use', untilMs: now(), attempt: 1 };
      for (const cb of stateChangeCbs) cb(key, failedState);
      return;
    }

    entry.bindErrorRetries += 1;
    if (entry.bindErrorRetries > MAX_CLASH_BIND_RETRIES) {
      entry.health.feedExit(null);
      return;
    }

    try {
      const newClashPort = await doAllocatePort({ base: CLASH_AUX_BASE, taken: allClaimedPorts() });

      // `allocatePort` above is async — the port could have been stopped, or even
      // restarted under the same key (a brand-new `entries.get(key)` entry), while we
      // were waiting on it (reviewer round 3, item 3). Respawning a STALE entry at this
      // point would either resurrect a process the caller explicitly stopped, or step
      // on whatever the fresh start already set up — silently bail instead.
      if (entry.stopping || entries.get(key) !== entry) return;

      const newClashSecret = randomBytes(16).toString('hex');
      const finalInput: RenderInput = { ...entry.callerInput, clash: { port: newClashPort, secret: newClashSecret } };
      const newConfig = renderConfig(finalInput);
      assertConfigInvariants(JSON.parse(newConfig));

      // Mutated in place (not a new PortEntry): the `/delay` poll and `probe()` both
      // read `entry.clashPort`/`entry.clashSecret` fresh on every call, so this alone
      // redirects them — no need to recreate the poll or any subscription.
      entry.clashPort = newClashPort;
      entry.clashSecret = newClashSecret;
      entry.lastConfig = newConfig;

      entry.process.start(newConfig);
      await recordSpawn(key, entry);
    } catch {
      // The reallocation/re-render/respawn itself failed (e.g. no free port at all, or
      // a render-invariant violation) — this must become a retryable state via
      // PortHealth's own backoff, never an unhandled rejection out of this
      // fire-and-forget `void handleBindError(...)` call (reviewer round 3, item 3).
      entry.health.feedExit(null);
    }
  }

  /**
   * Runs while `verifying` (spec §6.4): confirms the exit IP actually changed and reports
   * it back via `feedEstablishedThenVerify`. Retries the probe up to `MAX_EXIT_IP_ATTEMPTS`
   * times back to back; if every attempt fails, it does NOT immediately treat the port as
   * broken (reviewer I-2) — it first checks `/delay`. A 200 means the tunnel is genuinely
   * up and only geo is unverifiable, so the port goes `online` with unknown IP/country; a
   * non-200 (or clash_api unreachable) means the tunnel really is dead, so it drops to a
   * retry as before. Bails out silently if the entry was torn down / replaced / left
   * `verifying` underneath it.
   */
  async function verifyExitIp(key: string, entry: PortEntry, health: PortHealthLike): Promise<void> {
    const stillVerifying = () => !entry.stopping && entries.get(key) === entry && health.state.kind === 'verifying';
    for (let attempt = 1; attempt <= MAX_EXIT_IP_ATTEMPTS; attempt += 1) {
      try {
        const exit = await doExitIpProbe(entry.proxyPort, { auth: entry.auth });
        if (!stillVerifying()) return;
        health.feedEstablishedThenVerify(true, { exitIp: exit.ip, country: exit.country });
        return;
      } catch {
        if (!stillVerifying()) return;
        // else: fall through to the next attempt
      }
    }
    // Every exit-IP probe failed. Is the tunnel itself up? If `/delay` is 200 the port is
    // usable despite unverifiable geo (reviewer I-2) — go online with unknown IP/country.
    const delay = await delayWithDeadline(entry);
    if (!stillVerifying()) return;
    if (delay.code === 200) {
      health.feedEstablishedThenVerify(true, { exitIp: 'unknown', country: 'unknown', latencyMs: delay.ms });
    } else {
      health.feedEstablishedThenVerify(false);
    }
  }

  async function start(key: string, input: RenderInput, startOpts: EngineStartOptions = {}): Promise<void> {
    // Another key's engine, running or starting, already listens there: two processes on
    // one port can only end in a bind failure. Checked and reserved synchronously, so an
    // overlapping start sees this one.
    if (allClaimedPorts(key).has(input.listen.port)) throw new PortInUseError(input.listen.port);
    const reservation = { key, ports: new Set([input.listen.port]) };
    reserved.add(reservation);
    try {
      await startReserved(key, input, startOpts, reservation);
    } finally {
      // Registered in `entries` by now (or failed): the reservation has done its job.
      reserved.delete(reservation);
    }
  }

  async function startReserved(
    key: string,
    input: RenderInput,
    startOpts: EngineStartOptions,
    reservation: { key: string; ports: Set<number> },
  ): Promise<void> {
    const existing = entries.get(key);
    if (existing) await teardown(key, existing);

    // The proxy port itself is the one bind failure that's terminal, not retried with a
    // substitute (spec §6.2: `failed('port-in-use')`, "Move to another port"). Auxiliary
    // (clash) ports, by contrast, just get a different candidate via `allocatePort`'s own
    // scan — that retry is already built into `allocatePort` below.
    if (!(await doIsPortFree(input.listen.port))) {
      throw new PortInUseError(input.listen.port);
    }

    const clashPort = await reserveClashPort(reservation);
    const clashSecret = randomBytes(16).toString('hex');
    const finalInput: RenderInput = { ...input, clash: { port: clashPort, secret: clashSecret } };
    const config = renderConfig(finalInput);
    assertConfigInvariants(JSON.parse(config));

    const engineProcess = (options.createEngineProcess ?? ((o) => new EngineProcess(o)))({ binPath });
    const health = (options.createPortHealth ?? ((o) => new PortHealth(o)))({
      giveUpAfter: options.giveUpAfter,
      initialAttempt: startOpts.attempt,
    });

    const entry: PortEntry = {
      process: engineProcess,
      health,
      clashPort,
      clashSecret,
      proxyPort: input.listen.port,
      auth: input.listen.proxyAuth,
      callerInput: input,
      lastConfig: config,
      bindErrorRetries: 0,
      unansweredPolls: 0,
      cancelDelayPoll: () => undefined,
      unsubscribe: [],
      stopping: false,
    };
    entries.set(key, entry);
    lastKnownLogs.delete(key); // a fresh process: the old ring (if any) is stale now

    entry.unsubscribe.push(health.onStateChange((state) => {
      for (const cb of stateChangeCbs) cb(key, state);
    }));

    // Once sing-box signals "established"/the first 200, PortHealth moves to
    // `verifying`; that's this adapter's cue to confirm the exit IP actually changed
    // and report back, per spec §6.4.
    entry.unsubscribe.push(
      health.onStateChange((state) => {
        if (state.kind !== 'verifying') return;
        void verifyExitIp(key, entry, health);
      }),
    );

    // A port waiting out its back-off must not keep talking to the provider. sing-box
    // never exits on a 504 or a handshake timeout (spec §6.3): left running, a WireGuard
    // endpoint re-sends a handshake initiation every few seconds for as long as the
    // back-off lasts (keepalive and the /delay poll keep giving it traffic), which turns
    // a 30-minute back-off into hundreds of failed handshakes. Stop the child now; the
    // retry spawns a fresh one.
    entry.unsubscribe.push(
      health.onStateChange((state) => {
        if (state.kind !== 'retrying' && state.kind !== 'failed' && state.kind !== 'stopped') return;
        if (engineProcess.pid === undefined) return;
        entry.quiescing = true;
        void engineProcess
          .stop()
          .catch(() => undefined)
          .finally(() => {
            entry.quiescing = false;
          });
      }),
    );

    entry.unsubscribe.push(
      health.onRetryDue(() => {
        // The controller (if wired) owns the retry: it re-resolves the host and advances
        // to the next non-bad candidate before respawning via its own start path, so a
        // dead/stale IP is not looped on forever (reviewer I-1). Delegate and do NOT also
        // respawn `lastConfig` here, or the two would race onto the same port.
        if (retryDueCbs.size > 0) {
          for (const cb of retryDueCbs) cb(key);
          return;
        }
        void (async () => {
          // Integration fix: sing-box never exits by itself on a 504 / connect timeout
          // (spec §6.3), so the old child is usually STILL RUNNING when a retry is due.
          // Calling start() on it threw "EngineProcess.start: already started" from a
          // timer — an uncaught exception that froze the whole main process behind
          // Electron's modal error dialog. Stop it first (its exit is ours, not a crash).
          if (engineProcess.pid !== undefined) {
            entry.respawning = true;
            try {
              await engineProcess.stop();
            } finally {
              entry.respawning = false;
            }
          }
          if (entry.stopping || entries.get(key) !== entry) return;
          // Re-spawn with the MOST RECENT rendered config (reviewer item 6). A genuinely
          // different server is a `rotatePort`, not a retry.
          try {
            engineProcess.start(entry.lastConfig);
          } catch {
            health.feedExit(null);
            return;
          }
          // Re-record the pid on EVERY respawn (reviewer item 6).
          await recordSpawn(key, entry).catch(() => undefined);
        })();
      }),
    );

    entry.unsubscribe.push(
      engineProcess.onLog((line) => {
        entry.lastLogLine = line;
        const signal = doClassifyLog(line);
        if (signal) health.feedLog(signal);
      }),
    );

    entry.unsubscribe.push(
      engineProcess.onExit((info: ExitInfo) => {
        // Whatever the cause, that process is gone: drop its pid now. Kept while the port
        // waits out a back-off, a pid the OS may hand to another process would sit in
        // the registry for the next launch's orphan reaper. Only that pid: a respawn
        // records its own, and a late exit report must not drop it.
        const exitedPid = entry.spawnedPid;
        entry.spawnedPid = undefined;
        if (exitedPid !== undefined) void doRemovePid(options.registryPath, key, exitedPid).catch(() => undefined);
        if (entry.stopping || entry.respawning || entry.quiescing) return; // our own stop(), not a crash
        const collidedPort = detectBindErrorPort(entry.lastLogLine);
        if (collidedPort !== undefined) {
          void handleBindError(key, entry, collidedPort);
          return;
        }
        entry.bindErrorRetries = 0; // a clean/non-bind exit resets the reallocation counter
        health.feedExit(info.code);
      }),
    );

    const probeOnce = () => {
      // Bounded by `delayWithDeadline`, so this guard can only skip a tick, never wedge the poll.
      if (entry.probeInFlight) return;
      entry.probeInFlight = true;
      void delayWithDeadline(entry)
        .then((result: DelayResult) => {
          if (entry.stopping || entries.get(key) !== entry) return;
          // The round trip of a 200 is the port's latency (spec §4.2 Latency column). A
          // timed-out or errored poll is a failed probe; PortHealth decides what it means.
          health.feedDelay(result.code, result.code === 200 ? result.ms : undefined);
          watchHung(result);
        })
        .finally(() => {
          entry.probeInFlight = false;
        });
    };

    // Hung-engine watchdog: a process that is alive but frozen (deadlocked, SIGSTOPped)
    // never exits, so neither onExit nor a clean stop() would ever fire for it. Once the
    // controller API has ignored `unresponsiveKillAfter` polls in a row, kill it; its exit
    // is not flagged as ours, so it is fed to PortHealth as a crash and the normal
    // back-off/retry path restarts the engine.
    const watchHung = (result: DelayResult) => {
      if (!(result.code === 'error' && result.timedOut)) {
        entry.unansweredPolls = 0;
        return;
      }
      entry.unansweredPolls += 1;
      if (entry.unansweredPolls < unresponsiveKillAfter) return;
      entry.unansweredPolls = 0;
      // A stop already in progress escalates to SIGKILL on its own.
      if (engineProcess.pid === undefined || entry.quiescing || entry.respawning) return;
      void engineProcess.kill(options.killGraceMs).catch(() => undefined);
    };
    const cancelPoll = schedule(delayPollMs, probeOnce);
    const earlyTimers = initialProbeDelaysMs.map((ms) => {
      const t = setTimeout(() => {
        if (!entry.stopping && health.state.kind === 'connecting') probeOnce();
      }, ms);
      t.unref?.();
      return t;
    });
    entry.cancelDelayPoll = () => {
      cancelPoll();
      for (const t of earlyTimers) clearTimeout(t);
    };

    health.start();
    engineProcess.start(config);

    await recordSpawn(key, entry);
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
    return delayWithDeadline(entry);
  }

  function getLogs(key: string): string[] {
    // The live entry (if any) first; otherwise the ring captured at teardown time
    // (reviewer item 10) — never just blank the moment a port is stopped/rotated away.
    return entries.get(key)?.process.logs ?? lastKnownLogs.get(key) ?? [];
  }

  function onStateChange(cb: (key: string, state: PortState) => void): () => void {
    stateChangeCbs.add(cb);
    return () => stateChangeCbs.delete(cb);
  }

  function onRetryDue(cb: (key: string) => void): () => void {
    retryDueCbs.add(cb);
    return () => retryDueCbs.delete(cb);
  }

  return { start, stop, probe, getLogs, onStateChange, onRetryDue };
}
