import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import { promisify } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { singboxPath } from './singbox-path';
import { LogRing, redactLine } from './log-ring';

const execFileAsync = promisify(execFile);

const DEFAULT_RING_CAPACITY = 2000;
const DEFAULT_HARD_KILL_TIMEOUT_MS = 6000;

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

export interface EngineProcessOptions {
  /** Path to the sing-box binary. @default singboxPath() */
  binPath?: string;
  /** @default process.platform — overridable for tests, since stop() dispatches on it. */
  platform?: NodeJS.Platform;
  /** @default node:child_process's spawn — overridable for tests. */
  spawn?: typeof spawn;
  /** Grace period before SIGKILL on stop(). @default 6000 (spec §6.3). */
  hardKillTimeoutMs?: number;
  /** Ring buffer capacity for redacted log lines. @default 2000 */
  ringCapacity?: number;
  /** Win32 stop mechanism (`taskkill /pid <pid> /t /f`). Overridable for tests. */
  taskkill?: (pid: number) => Promise<void>;
}

async function defaultTaskkill(pid: number): Promise<void> {
  await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f']);
}

/**
 * Supervises one sing-box process for one port (spec §6.3). Spawns
 * `<bin> run -c stdin`, writes the rendered config to the child's stdin and
 * closes it, and surfaces redacted log lines and exit events. `stop()` sends
 * SIGINT on darwin/linux or runs `taskkill` on win32, resolving once the
 * child actually exits, with a hard-kill fallback after a grace period.
 */
export class EngineProcess {
  private readonly binPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: typeof spawn;
  private readonly hardKillTimeoutMs: number;
  private readonly taskkillFn: (pid: number) => Promise<void>;
  private readonly ring: LogRing;

  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private readonly logCbs = new Set<(line: string) => void>();
  private readonly exitCbs = new Set<(info: ExitInfo) => void>();

  constructor(opts: EngineProcessOptions = {}) {
    this.binPath = opts.binPath ?? singboxPath();
    this.platform = opts.platform ?? process.platform;
    this.spawnFn = opts.spawn ?? spawn;
    this.hardKillTimeoutMs = opts.hardKillTimeoutMs ?? DEFAULT_HARD_KILL_TIMEOUT_MS;
    this.taskkillFn = opts.taskkill ?? defaultTaskkill;
    this.ring = new LogRing(opts.ringCapacity ?? DEFAULT_RING_CAPACITY);
  }

  /** Spawns `<bin> run -c stdin`, writes `configJson` to the child's stdin, then closes it. */
  start(configJson: string): void {
    if (this.child) {
      throw new Error('EngineProcess.start: already started');
    }

    const child = this.spawnFn(this.binPath, ['run', '-c', 'stdin'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<
      Writable,
      Readable,
      Readable
    >;
    this.child = child;

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        if (rawLine.length === 0) continue;
        this.ring.push(rawLine);
        const redacted = redactLine(rawLine);
        for (const cb of this.logCbs) cb(redacted);
      }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.once('exit', (code, signal) => {
      for (const cb of this.exitCbs) cb({ code, signal });
    });

    child.stdin.write(configJson);
    child.stdin.end();
  }

  /**
   * Stops the engine: SIGINT on darwin/linux, `taskkill` on win32; resolves
   * once the child has actually exited. Falls back to a hard kill
   * (SIGKILL) if the child hasn't exited within `hardKillTimeoutMs`.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const hardKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, this.hardKillTimeoutMs);

      child.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardKillTimer);
        resolve();
      });

      if (this.platform === 'win32') {
        if (child.pid) {
          this.taskkillFn(child.pid).catch(() => {
            // best-effort: if taskkill itself fails, the hard-kill timer still covers us
          });
        }
      } else {
        try {
          child.kill('SIGINT');
        } catch {
          // already gone
        }
      }
    });

    this.child = null;
  }

  /** Subscribes to redacted log lines as they arrive. Returns an unsubscribe function. */
  onLog(cb: (line: string) => void): () => void {
    this.logCbs.add(cb);
    return () => this.logCbs.delete(cb);
  }

  /** Subscribes to the child's exit. Returns an unsubscribe function. */
  onExit(cb: (info: ExitInfo) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }

  /** All redacted log lines currently held in the ring buffer. */
  get logs(): string[] {
    return this.ring.lines;
  }
}
