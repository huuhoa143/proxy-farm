import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** sing-box release asset key (spec §2: pinned to 1.14.2). */
export type PlatformKey = 'darwin-arm64' | 'darwin-amd64' | 'windows-amd64';

const BINARY_NAME: Record<PlatformKey, string> = {
  'darwin-arm64': 'sing-box',
  'darwin-amd64': 'sing-box',
  'windows-amd64': 'sing-box.exe',
};

/** This module lives at app/src/main/engine/singbox-path.ts; the app root is three levels up. */
const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Maps a host platform/arch pair to its sing-box release asset key (spec §2). */
export function hostPlatformKey(platform: NodeJS.Platform, arch: string): PlatformKey {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-amd64';
  if (platform === 'win32' && arch === 'x64') return 'windows-amd64';
  throw new Error(`Unsupported platform "${platform}-${arch}" for sing-box. Supported: darwin-arm64, darwin-x64, win32-x64.`);
}

export interface SingboxPathOptions {
  /** @default process.platform */
  platform?: NodeJS.Platform;
  /** @default process.arch */
  arch?: string;
  /** @default auto-detected via electron's `app.isPackaged` (false outside Electron, e.g. in tests) */
  isPackaged?: boolean;
  /** Dev-mode root containing `resources/`. @default the app/ directory this module lives under. */
  appRoot?: string;
  /** Packaged-mode root (Electron's `process.resourcesPath`). Required when `isPackaged` is true. */
  resourcesPath?: string;
}

/**
 * Best-effort, side-effect-free detection of Electron's packaged state. Never
 * throws, and never `require`s the `electron` package unless this process is
 * actually running inside Electron (`process.versions.electron` is only set
 * there) — requiring it from plain Node (e.g. under vitest) would otherwise
 * trigger the package's lazy postinstall binary download.
 */
function detectIsPackaged(): boolean {
  if (!process.versions.electron) return false;
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    return Boolean(electron?.app?.isPackaged);
  } catch {
    return false;
  }
}

/**
 * Resolves the absolute path to the sing-box binary for the current (or
 * given) platform. Dev mode reads from `app/resources/sing-box/<platform>/`;
 * packaged mode reads from `<process.resourcesPath>/sing-box/<platform>/`
 * (spec §2).
 */
export function singboxPath(opts: SingboxPathOptions = {}): string {
  const platformKey = hostPlatformKey(opts.platform ?? process.platform, opts.arch ?? process.arch);
  const binaryName = BINARY_NAME[platformKey];
  const isPackaged = opts.isPackaged ?? detectIsPackaged();

  if (isPackaged) {
    const resourcesPath = opts.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath) {
      throw new Error('singboxPath: packaged mode but no resourcesPath was provided or available on process.resourcesPath');
    }
    return path.join(resourcesPath, 'sing-box', platformKey, binaryName);
  }

  const appRoot = opts.appRoot ?? DEFAULT_APP_ROOT;
  return path.join(appRoot, 'resources', 'sing-box', platformKey, binaryName);
}

/** The sing-box version the app ships and requires (checked at startup). */
export const SINGBOX_PINNED_VERSION = '1.14.2';
const PINNED_VERSION = SINGBOX_PINNED_VERSION;
const REQUIRED_TAGS = ['with_gvisor', 'with_wireguard', 'with_openvpn'] as const;

/**
 * Runs `<bin> version` and throws unless the output reports the pinned
 * version with all required build tags (spec §2).
 *
 * This is a short-lived sing-box process (~0.25 s) at every app start, before any port
 * or credential probe runs: a process sampler sees it as an engine that exited at once.
 */
export async function assertSingboxVersion(binPath: string = singboxPath()): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binPath, ['version']));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`assertSingboxVersion: failed to run "${binPath} version": ${message}`);
  }

  const versionMatch = stdout.match(/sing-box version (\S+)/);
  const version = versionMatch?.[1];
  if (version !== PINNED_VERSION) {
    throw new Error(`assertSingboxVersion: expected sing-box ${PINNED_VERSION}, got "${version ?? 'unknown'}" from "${binPath} version"`);
  }

  const tagsMatch = stdout.match(/Tags:\s*(.+)/);
  const tags = new Set((tagsMatch?.[1] ?? '').split(',').map((t) => t.trim()));
  const missing = REQUIRED_TAGS.filter((tag) => !tags.has(tag));
  if (missing.length > 0) {
    throw new Error(`assertSingboxVersion: sing-box ${PINNED_VERSION} at "${binPath}" is missing required tags: ${missing.join(', ')}`);
  }
}
