import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineProcess } from './supervisor';

const FAKE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-singbox.mjs');

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
});
