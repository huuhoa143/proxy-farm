import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { EngineProcess } from './supervisor';

// `import * as fs from 'node:fs'` yields a non-configurable ESM namespace
// object that vi.spyOn can't redefine; a CJS require() gives back the real,
// spy-able module object instead.
const fsModule = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

const FAKE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-singbox.mjs');
const NONEXISTENT_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'does-not-exist-xyz');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A minimal stand-in for a Node ChildProcess, with real streams so readline/data events behave normally. */
function makeFakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinChunks: string[] = [];
  stdin.on('data', (d: Buffer) => stdinChunks.push(d.toString('utf8')));

  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    kill: (signal?: string) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.pid = 424242;
  child.kill = vi.fn(() => true);

  return { child, stdinChunks };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('EngineProcess', () => {
  it('spawns the binary, pipes configJson to stdin, and surfaces its log lines', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN });
    const received: string[] = [];
    engine.onLog((line) => received.push(line));

    engine.start(JSON.stringify({ __fakeLogLines: ['INFO hello', 'INFO world'] }));

    await waitFor(() => received.length >= 2);
    expect(received).toEqual(['INFO hello', 'INFO world']);
    expect(engine.logs).toEqual(['INFO hello', 'INFO world']);

    await engine.stop();
  });

  it('redacts credentials before they ever reach onLog or .logs', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN });
    const received: string[] = [];
    engine.onLog((line) => received.push(line));

    engine.start(JSON.stringify({ __fakeLogLines: ['connecting username=svc-acct password=Tr0ub4dor&3'] }));

    await waitFor(() => received.length >= 1);
    expect(received[0]).not.toContain('Tr0ub4dor&3');
    expect(received[0]).not.toContain('svc-acct');
    expect(engine.logs.join('\n')).not.toContain('Tr0ub4dor&3');

    await engine.stop();
  });

  it('calls onExit when the child process exits on its own', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN });
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    engine.onExit((info) => exits.push(info));

    engine.start(JSON.stringify({ __fakeExitCode: 1 }));

    await waitFor(() => exits.length >= 1);
    expect(exits[0].code).toBe(1);
  });

  it('clears .child on a natural (crash) exit, so a fresh start() is allowed afterwards', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN });
    const exits: unknown[] = [];
    engine.onExit((info) => exits.push(info));

    engine.start(JSON.stringify({ __fakeExitCode: 1 })); // simulates a crash
    await waitFor(() => exits.length >= 1);

    // start() throws "already started" if .child wasn't cleared on the crash — this must not throw.
    const logged: string[] = [];
    engine.onLog((l) => logged.push(l));
    expect(() => engine.start(JSON.stringify({ __fakeLogLines: ['restarted'] }))).not.toThrow();
    await waitFor(() => logged.length >= 1);
    expect(logged).toContain('restarted');

    await engine.stop();
  });

  it('stop() sends SIGINT on non-win32 and resolves once the child exits', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN, platform: 'darwin' });
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    engine.onExit((info) => exits.push(info));
    const logged: string[] = [];
    engine.onLog((l) => logged.push(l));

    engine.start(JSON.stringify({}));
    await waitFor(() => logged.length >= 1); // wait for the child to be fully up before stopping

    await engine.stop();
    expect(exits).toHaveLength(1);
    expect(exits[0].signal === 'SIGINT' || exits[0].code === 0).toBe(true);
  });

  it('hard-kills after the timeout if the child ignores SIGINT/SIGTERM', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN, platform: 'darwin', hardKillTimeoutMs: 150 });
    const logged: string[] = [];
    engine.onLog((l) => logged.push(l));

    engine.start(JSON.stringify({ __fakeIgnoreSignals: true }));
    await waitFor(() => logged.length >= 1);

    const startedAt = Date.now();
    await engine.stop();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
  }, 10000);

  it('on win32 uses the injected taskkill instead of SIGINT', async () => {
    let taskkillCalledWith: number | undefined;
    const engine = new EngineProcess({
      binPath: FAKE_BIN,
      platform: 'win32',
      taskkill: async (pid) => {
        taskkillCalledWith = pid;
        process.kill(pid, 'SIGTERM'); // stand-in for `taskkill /pid <pid> /t /f` so the test can observe real termination
      },
    });
    const logged: string[] = [];
    engine.onLog((l) => logged.push(l));

    engine.start(JSON.stringify({}));
    await waitFor(() => logged.length >= 1);

    await engine.stop();
    expect(taskkillCalledWith).toBeGreaterThan(0);
  });

  it('onLog/onExit subscriptions can be unsubscribed', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN });
    const cb = vi.fn();
    const unsubscribe = engine.onLog(cb);
    unsubscribe();

    engine.start(JSON.stringify({ __fakeLogLines: ['INFO x'] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(cb).not.toHaveBeenCalled();

    await engine.stop();
  });

  it('a missing binary reports onExit(code:null, error) instead of crashing the process', async () => {
    const engine = new EngineProcess({ binPath: NONEXISTENT_BIN });
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> = [];
    engine.onExit((info) => exits.push(info));

    // If EngineProcess doesn't handle the child's 'error' event, this throws
    // an unhandled error and the whole test process crashes — the assertions
    // below never even run.
    engine.start(JSON.stringify({}));

    await waitFor(() => exits.length >= 1);
    expect(exits[0].code).toBeNull();
    expect(exits[0].signal).toBeNull();
    expect(exits[0].error).toBeInstanceOf(Error);
    expect(exits[0].error?.message).toMatch(/ENOENT/);
  });

  it('clears .pid after a missing-binary error, so a fresh start() is allowed', async () => {
    const engine = new EngineProcess({ binPath: NONEXISTENT_BIN });
    const exits: unknown[] = [];
    engine.onExit((info) => exits.push(info));
    engine.start(JSON.stringify({}));
    await waitFor(() => exits.length >= 1);

    expect(engine.pid).toBeUndefined();
    // start() throws "already started" if .child wasn't cleared — this must not throw.
    expect(() => engine.start(JSON.stringify({ __fakeExitCode: 0 }))).not.toThrow();
  });

  it('exposes .pid while running and clears it after a natural exit', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN });
    expect(engine.pid).toBeUndefined();

    const exits: unknown[] = [];
    engine.onExit((info) => exits.push(info));
    engine.start(JSON.stringify({ __fakeExitCode: 0 }));
    expect(typeof engine.pid).toBe('number');

    await waitFor(() => exits.length >= 1);
    expect(engine.pid).toBeUndefined();
  });

  it('a log line split across two stdout chunks is still classified/redacted as one line (readline buffering)', async () => {
    const { child } = makeFakeChild();
    const engine = new EngineProcess({ spawn: () => child as never });
    const received: string[] = [];
    engine.onLog((l) => received.push(l));

    engine.start('{}');
    child.stdout.write('INFO connecting username=al');
    child.stdout.write('ice password=hunter2\n');

    await waitFor(() => received.length >= 1);
    expect(received).toEqual(['INFO connecting username=[redacted] password=[redacted]']);
  });

  it('spawns with exactly ["run", "-c", "stdin"] and never writes the config to disk', async () => {
    const calls: unknown[][] = [];
    const spawnSpy = ((...args: Parameters<typeof realSpawn>) => {
      calls.push(args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realSpawn as any)(...args);
    }) as typeof realSpawn;

    const writeFileSpy = vi.spyOn(fsModule, 'writeFile');
    const writeFileSyncSpy = vi.spyOn(fsModule, 'writeFileSync');

    const engine = new EngineProcess({ binPath: FAKE_BIN, spawn: spawnSpy });
    const logged: string[] = [];
    engine.onLog((l) => logged.push(l));
    engine.start(JSON.stringify({ __fakeLogLines: ['hi'] }));
    await waitFor(() => logged.length >= 1);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(FAKE_BIN);
    expect(calls[0][1]).toEqual(['run', '-c', 'stdin']);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();

    writeFileSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
    await engine.stop();
  });

  it('after a hard-kill, the child process is actually gone', async () => {
    const engine = new EngineProcess({ binPath: FAKE_BIN, platform: 'darwin', hardKillTimeoutMs: 150 });
    const logged: string[] = [];
    engine.onLog((l) => logged.push(l));

    engine.start(JSON.stringify({ __fakeIgnoreSignals: true }));
    await waitFor(() => logged.length >= 1);
    const pid = engine.pid!;

    await engine.stop();
    expect(isAlive(pid)).toBe(false);
  }, 10000);
});
