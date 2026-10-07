import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface PidEntry {
  pid: number;
  exe: string;
  startedAt: number; // ms epoch (Date.now() at spawn time)
}

type Registry = Record<string, PidEntry>;

async function loadRegistry(registryPath: string): Promise<Registry> {
  try {
    const raw = await readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Registry) : {};
  } catch {
    return {};
  }
}

/** Writes via a temp file + rename so a crash mid-write never corrupts the registry. */
async function saveRegistry(registryPath: string, registry: Registry): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
  await rename(tmpPath, registryPath);
}

/** Records (or overwrites) the tracked process for `key` in the JSON registry at `registryPath` (spec §6.3). */
export async function recordPid(registryPath: string, key: string, entry: PidEntry): Promise<void> {
  const registry = await loadRegistry(registryPath);
  registry[key] = entry;
  await saveRegistry(registryPath, registry);
}

/** Removes the tracked process for `key`, if present. No-op if the key (or the file) doesn't exist. */
export async function removePid(registryPath: string, key: string): Promise<void> {
  const registry = await loadRegistry(registryPath);
  if (key in registry) {
    delete registry[key];
    await saveRegistry(registryPath, registry);
  }
}

export interface ProcessSnapshot {
  exe: string;
  startedAt: number; // ms epoch
}

export type ReadProcess = (pid: number) => Promise<ProcessSnapshot | null>;

const DEFAULT_START_TIME_TOLERANCE_MS = 5000;

/**
 * Best-effort real process reader: `ps` on macOS/Linux, `wmic` on Windows.
 * Resolves null if no such pid currently exists or its info can't be read.
 * Start-time resolution from `ps`/`wmic` is second-level at best, which is
 * why matching uses a tolerance window rather than exact equality — tests
 * that need exact control should inject `readProcess`.
 */
async function defaultReadProcess(pid: number): Promise<ProcessSnapshot | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('wmic', [
        'process',
        'where',
        `ProcessId=${pid}`,
        'get',
        'ExecutablePath,CreationDate',
        '/format:list',
      ]);
      const exeMatch = stdout.match(/ExecutablePath=(.+)/);
      const dateMatch = stdout.match(/CreationDate=(\d{14})/);
      if (!exeMatch || !dateMatch) return null;
      const exe = exeMatch[1].trim();
      const d = dateMatch[1];
      const startedAt = Date.UTC(
        Number(d.slice(0, 4)),
        Number(d.slice(4, 6)) - 1,
        Number(d.slice(6, 8)),
        Number(d.slice(8, 10)),
        Number(d.slice(10, 12)),
        Number(d.slice(12, 14)),
      );
      return { exe, startedAt };
    }

    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)]);
    const line = stdout.trim();
    if (!line) return null;
    // `lstart` is a fixed 24-char date like "Mon Oct  7 23:59:00 2026", `comm` follows.
    const dateStr = line.slice(0, 24).trim();
    const exe = line.slice(24).trim();
    const startedAt = new Date(dateStr).getTime();
    if (Number.isNaN(startedAt)) return null;
    return { exe, startedAt };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export interface ReapOrphansOptions {
  /** @default a best-effort OS process reader (`ps` on mac/linux, `wmic` on win32) */
  readProcess?: ReadProcess;
  /** @default SIGKILL via process.kill */
  kill?: (pid: number) => void;
  /** Allowed drift between recorded and observed start time. @default 5000ms */
  startTimeToleranceMs?: number;
}

/**
 * Kills every registry entry whose pid is currently alive AND whose exe path
 * and start time (within tolerance) match what was recorded — so a pid
 * reused by an unrelated process is never touched (spec §6.3: "A process is
 * killed only when pid, exe path and start time all match, so a reused pid
 * is never touched"). Always clears the registry afterwards: every entry
 * belongs to a previous session, matched-and-reaped or not. Resolves the
 * number of processes killed.
 */
export async function reapOrphans(registryPath: string, opts: ReapOrphansOptions = {}): Promise<number> {
  const registry = await loadRegistry(registryPath);
  const readProcess = opts.readProcess ?? defaultReadProcess;
  const kill = opts.kill ?? defaultKill;
  const tolerance = opts.startTimeToleranceMs ?? DEFAULT_START_TIME_TOLERANCE_MS;

  let killedCount = 0;
  for (const entry of Object.values(registry)) {
    if (!isAlive(entry.pid)) continue;
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await readProcess(entry.pid);
    if (!snapshot) continue;
    const exeMatches = snapshot.exe === entry.exe;
    const timeMatches = Math.abs(snapshot.startedAt - entry.startedAt) <= tolerance;
    if (exeMatches && timeMatches) {
      kill(entry.pid);
      killedCount += 1;
    }
  }

  await saveRegistry(registryPath, {});
  return killedCount;
}
