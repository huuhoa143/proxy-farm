import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const APP_ROOT = path.resolve(__dirname, '../../..');
/** The packaged app: `Proxy Farm.app` on macOS, the unpacked folder on Windows. */
export const APP_BUNDLE = IS_WIN
  ? path.join(APP_ROOT, 'out', 'Proxy Farm-win32-x64')
  : path.join(APP_ROOT, 'out', `Proxy Farm-darwin-${process.arch}`, 'Proxy Farm.app');
export const APP_EXE = IS_WIN ? path.join(APP_BUNDLE, 'Proxy Farm.exe') : path.join(APP_BUNDLE, 'Contents', 'MacOS', 'Proxy Farm');
export const BUNDLED_SINGBOX = IS_WIN
  ? path.join(APP_BUNDLE, 'resources', 'sing-box', 'windows-amd64', 'sing-box.exe')
  : path.join(APP_BUNDLE, 'Contents', 'Resources', 'sing-box', process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64', 'sing-box');

export interface RunningApp {
  proc: ChildProcess;
  pid: number;
  browser: Browser;
  page: Page;
  output: () => string;
  /** Graceful quit (SIGTERM, or `--quit` on Windows → app.quit → before-quit stops every
   * engine); resolves on exit. */
  quit(): Promise<number | null>;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Launches the packaged app with an isolated profile (PROXYFARM_USER_DATA_DIR) and the
 * Chromium mock keychain (so an ad-hoc-signed rebuild never blocks on a macOS keychain
 * prompt), then attaches Playwright over CDP to the main window.
 */
export async function launchPackagedApp(userDataDir: string): Promise<RunningApp> {
  if (!existsSync(APP_EXE)) throw new Error(`packaged app missing: ${APP_EXE} — run \`pnpm run package\` first`);
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true }); // a previous launch's port would be stale
  let log = '';
  const proc = spawn(APP_EXE, ['--remote-debugging-port=0', '--use-mock-keychain'], {
    env: { ...process.env, PROXYFARM_USER_DATA_DIR: userDataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(path.dirname(userDataDir), `pf-e2e-app-${Date.now()}.log`);
  const append = (d: Buffer) => {
    log += d;
    appendFileSync(logFile, d);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  const port = await waitFor(
    () => {
      if (!existsSync(portFile)) return undefined;
      const first = readFileSync(portFile, 'utf8').split('\n')[0];
      return first ? Number(first) : undefined;
    },
    30_000,
    'DevToolsActivePort',
  );
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor(() => browser.contexts()[0]?.pages()[0], 30_000, 'main window');
  await page.waitForLoadState('domcontentloaded');
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  return {
    proc,
    pid: proc.pid!,
    browser,
    page,
    output: () => log,
    async quit() {
      await browser.close().catch(() => undefined);
      // Windows has no SIGTERM for a GUI app (proc.kill terminates it outright): ask the
      // running instance to quit through a second launch instead.
      if (IS_WIN) spawn(APP_EXE, ['--quit'], { env: { ...process.env, PROXYFARM_USER_DATA_DIR: userDataDir }, stdio: 'ignore' });
      else proc.kill('SIGTERM');
      return exited;
    },
  };
}
