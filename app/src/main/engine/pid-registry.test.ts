import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordPid, removePid, reapOrphans } from './pid-registry';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

function waitExit(child: ChildProcess, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitExit: timed out')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('recordPid / removePid', () => {
  let dir: string;
  let registryPath: string;

  afterEach(async () => {
    // nothing to clean up — temp dirs are per-test under os.tmpdir()
  });

  it('records an entry retrievable as JSON, then removes it', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    registryPath = path.join(dir, 'pids.json');

    await recordPid(registryPath, 'hma:JP-1', { pid: 4242, exe: '/path/to/sing-box', startedAt: 1700000000000 });
    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(raw['hma:JP-1']).toEqual({ pid: 4242, exe: '/path/to/sing-box', startedAt: 1700000000000 });

    await recordPid(registryPath, 'surfshark:jp-tok', { pid: 4343, exe: '/path/to/sing-box', startedAt: 1700000001000 });
    await removePid(registryPath, 'hma:JP-1');
    const raw2 = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(raw2).toEqual({ 'surfshark:jp-tok': { pid: 4343, exe: '/path/to/sing-box', startedAt: 1700000001000 } });
  });

  it('removePid on a missing key is a no-op', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    registryPath = path.join(dir, 'pids.json');
    await expect(removePid(registryPath, 'nope')).resolves.toBeUndefined();
  });
});

describe('reapOrphans', () => {
  it('kills a process whose pid, exe, and start time all match', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    const registryPath = path.join(dir, 'pids.json');
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));

    await recordPid(registryPath, 'k1', { pid: child.pid!, exe: '/fake/sing-box', startedAt: 1700000000000 });

    // Attach the exit listener before triggering the kill — SIGKILL is near-instant,
    // so listening only after reapOrphans resolves risks missing the (one-shot) event.
    const exited = waitExit(child);
    const killed = await reapOrphans(registryPath, {
      readProcess: async (pid) => (pid === child.pid ? { exe: '/fake/sing-box', startedAt: 1700000000000 } : null),
    });

    expect(killed).toBe(1);
    await exited;
    expect(isAlive(child.pid!)).toBe(false);

    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(raw).toEqual({});
  });

  it('does NOT kill when the exe path does not match (pid reused by another process)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    const registryPath = path.join(dir, 'pids.json');
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));

    try {
      await recordPid(registryPath, 'k1', { pid: child.pid!, exe: '/fake/sing-box', startedAt: 1700000000000 });

      const killed = await reapOrphans(registryPath, {
        readProcess: async (pid) => (pid === child.pid ? { exe: '/some/other/binary', startedAt: 1700000000000 } : null),
      });

      expect(killed).toBe(0);
      expect(isAlive(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('does NOT kill when the start time does not match beyond tolerance', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    const registryPath = path.join(dir, 'pids.json');
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));

    try {
      await recordPid(registryPath, 'k1', { pid: child.pid!, exe: '/fake/sing-box', startedAt: 1700000000000 });

      const killed = await reapOrphans(registryPath, {
        readProcess: async (pid) => (pid === child.pid ? { exe: '/fake/sing-box', startedAt: 1700000500000 } : null),
      });

      expect(killed).toBe(0);
      expect(isAlive(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('does NOT kill when the recorded process is no longer running', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    const registryPath = path.join(dir, 'pids.json');
    const child = spawnSleeper();
    await new Promise((r) => child.once('spawn', r));
    const deadPid = child.pid!;
    child.kill('SIGKILL');
    await waitExit(child);

    await recordPid(registryPath, 'k1', { pid: deadPid, exe: '/fake/sing-box', startedAt: 1700000000000 });

    const killed = await reapOrphans(registryPath, {
      readProcess: async () => ({ exe: '/fake/sing-box', startedAt: 1700000000000 }),
    });

    expect(killed).toBe(0);
  });

  it('clears the registry file even when nothing matched', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    const registryPath = path.join(dir, 'pids.json');
    await recordPid(registryPath, 'k1', { pid: 999999, exe: '/fake/sing-box', startedAt: 1700000000000 });

    await reapOrphans(registryPath, { readProcess: async () => null });

    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(raw).toEqual({});
  });

  it('handles a missing registry file as empty (no throw, returns 0)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    const registryPath = path.join(dir, 'does-not-exist.json');
    await expect(reapOrphans(registryPath)).resolves.toBe(0);
  });
});
