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
  const tmpPath = `${registryPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
  await rename(tmpPath, registryPath);
}

/**
 * Serializes every read-modify-write against a given registry file, keyed by
 * its path: `recordPid`/`removePid` each do a full load → mutate → save, and
 * without this queue two concurrent calls racing on the same file would
 * both load the same "before" state and the second save would silently
 * clobber the first's write. Chaining through a per-path promise queue makes
 * concurrent calls against the same file behave like a strictly-ordered
 * sequence of transactions; a failed task never poisons the chain for
 * subsequent ones.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueue<T>(registryPath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(registryPath) ?? Promise.resolve();
  const result = previous.then(task, task);
  writeQueues.set(
    registryPath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Records (or overwrites) the tracked process for `key` in the JSON registry at `registryPath` (spec §6.3). */
export async function recordPid(registryPath: string, key: string, entry: PidEntry): Promise<void> {
  return enqueue(registryPath, async () => {
    const registry = await loadRegistry(registryPath);
    registry[key] = entry;
    await saveRegistry(registryPath, registry);
  });
}

/** Removes the tracked process for `key`, if present. No-op if the key (or the file) doesn't exist. */
export async function removePid(registryPath: string, key: string): Promise<void> {
  return enqueue(registryPath, async () => {
    const registry = await loadRegistry(registryPath);
    if (key in registry) {
      delete registry[key];
      await saveRegistry(registryPath, registry);
    }
  });
}

export interface ProcessSnapshot {
  exe: string;
  startedAt: number; // ms epoch
}

export type ReadProcess = (pid: number) => Promise<ProcessSnapshot | null>;

const DEFAULT_START_TIME_TOLERANCE_MS = 5000;

/**
 * Parses macOS/Linux `ps -o lstart=,comm= -p <pid>` output, e.g.
 * `"Thu Oct  8 00:36:38 2026     /bin/zsh"` — `lstart` is a fixed 24-char
 * date, `comm` follows. Exported for testing against a captured fixture
 * (start-time resolution from `ps` is second-level at best, hence the
 * tolerance window used by `reapOrphans` rather than exact equality).
 */
export function parseDarwinPsOutput(stdout: string): ProcessSnapshot | null {
  const line = stdout.trim();
  if (!line) return null;
  const dateStr = line.slice(0, 24).trim();
  const exe = line.slice(24).trim();
  if (!exe) return null;
  const startedAt = new Date(dateStr).getTime();
  if (Number.isNaN(startedAt)) return null;
  return { exe, startedAt };
}

/**
 * Parses the output of the PowerShell `Get-CimInstance Win32_Process | ...
 * ConvertTo-Json` command `defaultReadProcess` runs on win32 — a compact
 * JSON object `{"ExecutablePath": "...", "CreationDateUtc": "<ISO-8601 UTC>"}`.
 * The UTC offset is handled by asking PowerShell itself for an ISO-8601 UTC
 * string (`.ToUniversalTime().ToString('o')`), so there's no local-timezone
 * ambiguity left for this parser to get wrong.
 */
export function parseWindowsProcessJson(stdout: string): ProcessSnapshot | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: { ExecutablePath?: string; CreationDateUtc?: string };
  try {
    parsed = JSON.parse(trimmed) as { ExecutablePath?: string; CreationDateUtc?: string };
  } catch {
    return null;
  }
  if (!parsed.ExecutablePath || !parsed.CreationDateUtc) return null;
  const startedAt = new Date(parsed.CreationDateUtc).getTime();
  if (Number.isNaN(startedAt)) return null;
  return { exe: parsed.ExecutablePath, startedAt };
}

/**
 * Best-effort real process reader: `ps` on macOS/Linux, PowerShell's
 * `Get-CimInstance Win32_Process` on Windows (`wmic` is deprecated/removed
 * on newer Windows builds). Resolves null if no such pid currently exists or
 * its info can't be read. Tests that need exact control should inject
 * `readProcess` instead of relying on this.
 */
async function defaultReadProcess(pid: number): Promise<ProcessSnapshot | null> {
  try {
    if (process.platform === 'win32') {
      const script =
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
        `Select-Object ExecutablePath,@{Name='CreationDateUtc';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ` +
        `ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      return parseWindowsProcessJson(stdout);
    }

    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)]);
    return parseDarwinPsOutput(stdout);
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
  /** @default a best-effort OS process reader (`ps` on mac/linux, PowerShell on win32) */
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
  return enqueue(registryPath, async () => {
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
  });
}
