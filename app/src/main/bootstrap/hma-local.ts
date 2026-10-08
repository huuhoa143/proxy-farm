import { existsSync, readFile, unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';
import { parseDeviceCreds, type DeviceCreds } from '../providers/hma/token';

/** spec §5.1: world-readable on macOS, no admin needed. */
export const MAC_HMA_TOKEN_PATH = '/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json';
/** spec §7: the Windows install dir (credentials themselves need the helper). */
export const WIN_HMA_DIR = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Privax', 'HMA VPN');

export type HmaRead =
  | { status: 'found'; creds: DeviceCreds }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  /** Windows: HMA installed, but reading credentials needs the helper (spec §7). */
  | { status: 'helper-missing' };

export interface HmaLocalSource {
  read(): Promise<HmaRead>;
  /** Calls `cb` (debounced) whenever the credentials file changes, appears or vanishes. */
  watch(cb: () => void): () => void;
}

export interface HmaLocalSourceOptions {
  platform?: NodeJS.Platform;
  tokenPath?: string;
  winHmaDir?: string;
  /** stat-poll interval: HMA rewrites the file via rename, which fs.watch misses. */
  pollMs?: number;
}

/**
 * Reads HMA's local device credentials (spec §5.1). macOS: parses `tokenCoreSE.json`
 * with the providers module's `parseDeviceCreds`. Windows: credentials are admin-only
 * and need the helper (spec §7, not built yet) — reports `helper-missing` when HMA is
 * installed so the UI shows "Enable HMA support".
 */
export function createHmaLocalSource(opts: HmaLocalSourceOptions = {}): HmaLocalSource {
  const platform = opts.platform ?? process.platform;
  const tokenPath = opts.tokenPath ?? MAC_HMA_TOKEN_PATH;
  const winHmaDir = opts.winHmaDir ?? WIN_HMA_DIR;
  const pollMs = opts.pollMs ?? 3000;

  async function read(): Promise<HmaRead> {
    if (platform === 'win32') return existsSync(winHmaDir) ? { status: 'helper-missing' } : { status: 'missing' };
    if (platform !== 'darwin') return { status: 'missing' };
    const text = await new Promise<string | null>((resolve) => readFile(tokenPath, 'utf8', (err, data) => resolve(err ? null : data)));
    if (text === null) return { status: 'missing' };
    try {
      return { status: 'found', creds: parseDeviceCreds(text) };
    } catch (err) {
      return { status: 'invalid', message: (err as Error).message };
    }
  }

  function watch(cb: () => void): () => void {
    if (platform !== 'darwin') return () => undefined;
    const listener = (curr: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) cb();
    };
    watchFile(tokenPath, { interval: pollMs, persistent: false }, listener);
    return () => unwatchFile(tokenPath, listener);
  }

  return { read, watch };
}
