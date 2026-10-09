import { existsSync, readdirSync, readFile, unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';
import { parseAuthFile, parseDeviceCreds, type DeviceCreds } from '../providers/hma/token';
import { hmaAuthPath, hmaMirrorDir, hmaMirrorPath } from './hma-windows';

/** spec §5.1: world-readable on macOS, no admin needed. */
export const MAC_HMA_TOKEN_PATH = '/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json';
/** spec §7: the Windows install dir (its credentials file is admin-only). */
export const WIN_HMA_DIR = path.win32.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Privax', 'HMA VPN');

export type HmaRead =
  | { status: 'found'; creds: DeviceCreds }
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  /** Windows: HMA installed, but HMA support (the credentials copy, spec §7) isn't enabled. */
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
  /** Windows: HMA's own (admin-only) `auth` file. */
  winAuthPath?: string;
  /** Windows: the copy HMA support keeps readable for this user, and its folder. */
  winMirrorPath?: string;
  winMirrorDir?: string;
  /** stat-poll interval: HMA rewrites the file via rename, which fs.watch misses. */
  pollMs?: number;
}

type FileRead = { text: string } | { error: NodeJS.ErrnoException };

function readText(file: string): Promise<FileRead> {
  return new Promise((resolve) => readFile(file, 'utf8', (error, text) => resolve(error ? { error } : { text })));
}

function parsed(text: string, parse: (text: string) => DeviceCreds): HmaRead {
  try {
    return { status: 'found', creds: parse(text) };
  } catch (err) {
    return { status: 'invalid', message: (err as Error).message };
  }
}

/**
 * Reads HMA's local device credentials (spec §5.1).
 * - macOS: parses `tokenCoreSE.json` with the providers module's `parseDeviceCreds`.
 * - Windows: parses the `auth` file with `parseAuthFile`. HMA's own file is admin-only; it
 *   is preferred whenever the app happens to run elevated, and otherwise the copy kept by HMA
 *   support (`hma-windows.ts`) is read. Once HMA support is enabled, a missing copy means
 *   HMA has no credentials (not signed in); before that, an HMA install reports
 *   `helper-missing` so the UI offers "Enable HMA support".
 */
export function createHmaLocalSource(opts: HmaLocalSourceOptions = {}): HmaLocalSource {
  const platform = opts.platform ?? process.platform;
  const tokenPath = opts.tokenPath ?? MAC_HMA_TOKEN_PATH;
  const winHmaDir = opts.winHmaDir ?? WIN_HMA_DIR;
  const winAuthPath = opts.winAuthPath ?? hmaAuthPath();
  const winMirrorPath = opts.winMirrorPath ?? hmaMirrorPath();
  const winMirrorDir = opts.winMirrorDir ?? hmaMirrorDir();
  const pollMs = opts.pollMs ?? 3000;

  /** HMA's own folder is admin-only: listing it succeeds only when the app runs elevated. */
  function hmaFolderReadable(): boolean {
    try {
      readdirSync(path.win32.dirname(winAuthPath));
      return true;
    } catch {
      return false;
    }
  }

  async function readWindows(): Promise<HmaRead> {
    // HMA's own file first: when it is readable (the app runs elevated) it is the current
    // pair, while the copy may lag a rotation by up to the task's 5 minutes.
    const direct = await readText(winAuthPath);
    if ('text' in direct) return parsed(direct.text, parseAuthFile);
    // Its folder is readable but holds no credentials: HMA is signed out, whatever the copy says.
    if (direct.error.code === 'ENOENT' && hmaFolderReadable()) return { status: 'invalid', message: 'hma: not signed in' };
    const mirror = await readText(winMirrorPath);
    if ('text' in mirror) return parsed(mirror.text, parseAuthFile);
    // HMA support is on (its folder is readable) but there is no copy: HMA is installed and
    // signed out (the task removes the copy when HMA has none), so point the user at HMA
    // rather than telling them it isn't installed.
    if (mirror.error.code === 'ENOENT' && existsSync(winMirrorDir)) {
      return { status: 'invalid', message: 'hma: no credentials copy yet (sign in to HMA and connect once)' };
    }
    return existsSync(winHmaDir) ? { status: 'helper-missing' } : { status: 'missing' };
  }

  async function read(): Promise<HmaRead> {
    if (platform === 'win32') return readWindows();
    if (platform !== 'darwin') return { status: 'missing' };
    const file = await readText(tokenPath);
    if (!('text' in file)) return { status: 'missing' };
    return parsed(file.text, parseDeviceCreds);
  }

  function watch(cb: () => void): () => void {
    // Windows: the copy, plus HMA's own file only when this process can see it (elevated);
    // otherwise stat-polling it could never succeed.
    const watched =
      platform === 'win32' ? (hmaFolderReadable() ? [winMirrorPath, winAuthPath] : [winMirrorPath]) : platform === 'darwin' ? [tokenPath] : [];
    const listener = (curr: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) cb();
    };
    for (const file of watched) watchFile(file, { interval: pollMs, persistent: false }, listener);
    return () => {
      for (const file of watched) unwatchFile(file, listener);
    };
  }

  return { read, watch };
}
