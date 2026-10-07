import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordPid, removePid, reapOrphans, parseDarwinPsOutput, parseWindowsProcessJson } from './pid-registry';

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

  it('serializes concurrent recordPid calls so all of them persist (no lost updates)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    registryPath = path.join(dir, 'pids.json');

    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordPid(registryPath, `k${i}`, { pid: 1000 + i, exe: '/path/to/sing-box', startedAt: 1700000000000 + i }),
      ),
    );

    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(Object.keys(raw)).toHaveLength(N);
    for (let i = 0; i < N; i += 1) {
      expect(raw[`k${i}`]).toEqual({ pid: 1000 + i, exe: '/path/to/sing-box', startedAt: 1700000000000 + i });
    }
  });

  it('serializes an interleaved mix of concurrent recordPid/removePid calls correctly', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pf-pidreg-'));
    registryPath = path.join(dir, 'pids.json');

    await recordPid(registryPath, 'keep', { pid: 1, exe: '/bin/a', startedAt: 1 });
    await recordPid(registryPath, 'doomed', { pid: 2, exe: '/bin/b', startedAt: 2 });

    await Promise.all([
      recordPid(registryPath, 'new1', { pid: 3, exe: '/bin/c', startedAt: 3 }),
      removePid(registryPath, 'doomed'),
      recordPid(registryPath, 'new2', { pid: 4, exe: '/bin/d', startedAt: 4 }),
    ]);

    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(raw).toEqual({
      keep: { pid: 1, exe: '/bin/a', startedAt: 1 },
      new1: { pid: 3, exe: '/bin/c', startedAt: 3 },
      new2: { pid: 4, exe: '/bin/d', startedAt: 4 },
    });
  });
});

describe('parseDarwinPsOutput', () => {
  it('parses a real `ps -o lstart=,comm=` line (captured fixture)', () => {
    // Captured from `ps -o lstart=,comm= -p $$` on macOS.
    const fixture = 'Thu Oct  8 00:36:38 2026     /bin/zsh';
    const result = parseDarwinPsOutput(fixture);
    expect(result).not.toBeNull();
    expect(result?.exe).toBe('/bin/zsh');
    expect(result?.startedAt).toBe(new Date('Thu Oct  8 00:36:38 2026').getTime());
  });

  it('parses a longer absolute path in the comm field', () => {
    const fixture = 'Mon Jan  5 09:08:07 2026     /Users/robin/Works/deployments/proxy-farm/app/resources/sing-box/darwin-arm64/sing-box';
    const result = parseDarwinPsOutput(fixture);
    expect(result?.exe).toBe('/Users/robin/Works/deployments/proxy-farm/app/resources/sing-box/darwin-arm64/sing-box');
  });

  it('returns null for empty output (no such pid)', () => {
    expect(parseDarwinPsOutput('')).toBeNull();
    expect(parseDarwinPsOutput('   \n')).toBeNull();
  });
});

describe('parseWindowsProcessJson', () => {
  it('parses a Get-CimInstance ConvertTo-Json fixture', () => {
    const fixture = '{"ExecutablePath":"C:\\\\Program Files\\\\ProxyFarm\\\\sing-box.exe","CreationDateUtc":"2026-10-08T00:36:38.1234567Z"}';
    const result = parseWindowsProcessJson(fixture);
    expect(result?.exe).toBe('C:\\Program Files\\ProxyFarm\\sing-box.exe');
    expect(result?.startedAt).toBe(new Date('2026-10-08T00:36:38.123Z').getTime());
  });

  it('returns null for empty output (no such pid)', () => {
    expect(parseWindowsProcessJson('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseWindowsProcessJson('not json')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(parseWindowsProcessJson('{"ExecutablePath":"C:\\\\x.exe"}')).toBeNull();
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
