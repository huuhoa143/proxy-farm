/**
 * Auto-update service (spec §9), electron-updater driven. Architecture mirrors
 * lingoreup's updater (check-on-start + daily check, autoDownload off, status pushed to
 * the renderer, download-then-quitAndInstall, a manual-download fallback to GitHub
 * Releases on error, and the "no published channel file yet = up to date, not an error"
 * + "missing app-update.yml" special cases) — but with three deliberate departures:
 *
 *  1. Proxy Farm ships a proper Developer ID + notarized + stapled build (spec §9), so
 *     Squirrel.Mac accepts the update: we call the STANDARD `autoUpdater.quitAndInstall()`
 *     on every platform. lingoreup's DIY macOS ZIP-and-swap installer is NOT ported, and
 *     in particular we never delete the app's Safe Storage / Keychain item — Proxy Farm
 *     keeps the user's VPN provider credentials under `safeStorage` (session-secrets.ts /
 *     store/secrets.ts), and wiping the keychain on every update would destroy their saved
 *     HMA/ZoogVPN/Surfshark accounts.
 *  2. Before quitAndInstall we cleanly stop every running sing-box engine (the composition
 *     root's `stopAllEngines`/shutdown path) so no tunnel is orphaned across the update.
 *  3. autoDownload stays off; download+install is user-initiated from the Settings screen.
 *
 * The electron bits (the `autoUpdater`, the window, timers, the app version, shell) are
 * all injected so the pure helpers and the state-transition logic are unit-testable with
 * a fake autoUpdater and no network.
 */
import type { UpdateErrorKey, UpdateStatus } from '../../shared/contracts';
import type { WebContentsLike } from '../ipc/index';

// ───────────────────────── pure helpers (unit-tested directly) ─────────────────────────

/** electron-updater throws ENOENT on `app-update.yml` for bundles packaged before the
 * YAML was embedded (spec: forge `packageAfterCopy` writes it). Route those users to the
 * releases page so they recover by reinstalling once. */
export function isMissingAppUpdateConfig(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; path?: string };
  return e.code === 'ENOENT' && typeof e.path === 'string' && /app-update\.yml$/.test(e.path);
}

/**
 * electron-updater raises this when the release feed has no channel file for this
 * platform — i.e. no published release carries latest.yml yet (e.g. only a macOS
 * `latest-mac.yml` has shipped, so a Windows client 404s on `latest.yml`). That means
 * "you're up to date", NOT a failure: it fires on every check until the first release for
 * this platform is cut. Detection is deliberately NARROW — the updater's own channel-file
 * error code plus its "Cannot find channel …" message for older builds. A bare
 * `HttpError: 404` must NOT match: the 'error' event also fires for installer-download
 * failures (a release asset renamed/deleted after latest.yml published), and swallowing
 * those as "up to date" would hide a real, actionable failure and suppress the
 * manual-download escape hatch.
 */
export function isNoPublishedRelease(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  if (e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /Cannot find channel .*update info/i.test(msg);
}

/** Socket/DNS error codes and Chromium `net::ERR_*` failures that mean "couldn't reach
 * GitHub", as opposed to the feed answering with something unusable. */
const NETWORK_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EPIPE']);

/**
 * Maps an updater failure to a known kind so the renderer can show it in the UI language
 * (the raw message is English and is kept only as details). Unknown failures are
 * `generic`.
 */
export function classifyUpdaterError(error: unknown): UpdateErrorKey {
  if (isMissingAppUpdateConfig(error)) return 'no-auto-update';
  const e = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || /No published versions/i.test(message)) return 'no-releases';
  if (NETWORK_ERROR_CODES.has(code) || /net::ERR_|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)\b|socket hang up|network/i.test(message)) {
    return 'network';
  }
  return 'generic';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ───────────────────────── injectable electron surface ─────────────────────────

/** The slice of electron-updater's `autoUpdater` this service uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  logger: unknown;
  on(event: string, listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** The slice of a `BrowserWindow` the service needs to push status to the renderer. */
export interface UpdaterWindowLike {
  isDestroyed(): boolean;
  webContents: WebContentsLike;
}

export interface UpdaterServiceDeps {
  autoUpdater: AutoUpdaterLike;
  /** Running app version — `() => app.getVersion()` in production. */
  getAppVersion: () => string;
  /** Push a status object to every window (→ `broadcastUpdateStatus`). */
  broadcast: (windows: Iterable<WebContentsLike>, status: UpdateStatus) => void;
  /** Stop every running sing-box engine (reuse the composition root shutdown path) before
   * quit+install, so no tunnel is orphaned across the update (critical difference #2). */
  stopAllEngines: () => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
  /** GitHub Releases "latest" page for the manual fallback. */
  releasesUrl?: string;
  /** Injectable timers, so periodic checks are testable without real time. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Defers the actual quit+install so the IPC response reaches the renderer first;
   * default `setImmediate`. Tests capture the callback to assert ordering. */
  scheduleInstall?: (fn: () => void) => void;
}

export interface UpdaterService {
  setMainWindow(window: UpdaterWindowLike | null): void;
  getStatus(): UpdateStatus;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadAndInstall(): Promise<{ success: boolean; error?: string }>;
  startPeriodicCheck(intervalHours?: number): void;
  stopPeriodicCheck(): void;
}

const DEFAULT_RELEASES_URL = (() => {
  const owner = process.env.UPDATER_REPO_OWNER || 'huuhoa143';
  const repo = process.env.UPDATER_REPO_NAME || 'proxy-farm';
  return `https://github.com/${owner}/${repo}/releases/latest`;
})();

export function createUpdaterService(deps: UpdaterServiceDeps): UpdaterService {
  const log = deps.log ?? (() => undefined);
  const setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const scheduleInstall = deps.scheduleInstall ?? ((fn) => setImmediate(fn));
  const releasesUrl = deps.releasesUrl ?? DEFAULT_RELEASES_URL;

  let mainWindow: UpdaterWindowLike | null = null;
  let checkInterval: unknown = null;
  // Single-flight for download+install: a second IPC arriving mid-download must not
  // re-enter downloadUpdate or schedule a second quitAndInstall.
  let installing = false;

  let status: UpdateStatus = { phase: 'idle', currentVersion: deps.getAppVersion() };

  function setStatus(next: Omit<UpdateStatus, 'currentVersion'>): void {
    status = { ...next, currentVersion: deps.getAppVersion() };
    if (mainWindow && !mainWindow.isDestroyed()) {
      deps.broadcast([mainWindow.webContents], status);
    }
  }

  // ── electron-updater wiring ──
  // Feed URL is intentionally NOT set here: the single source of truth is the bundled
  // Contents/Resources/app-update.yml written at package time by the forge
  // packageAfterCopy hook (forge.config.ts). Keeping setFeedURL out prevents drift.
  deps.autoUpdater.autoDownload = false;
  deps.autoUpdater.logger = deps.log ? { info: log, warn: log, error: log, debug: log } : null;

  deps.autoUpdater.on('checking-for-update', () => {
    log('updater: checking for update');
    setStatus({ phase: 'checking' });
  });

  deps.autoUpdater.on('update-available', (info: unknown) => {
    const i = (info ?? {}) as { version?: string; releaseNotes?: string };
    log('updater: update available', i.version);
    setStatus({ phase: 'available', availableVersion: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : undefined });
  });

  deps.autoUpdater.on('update-not-available', () => {
    log('updater: no update available');
    setStatus({ phase: 'up-to-date' });
  });

  deps.autoUpdater.on('download-progress', (progress: unknown) => {
    const p = (progress ?? {}) as { percent?: number };
    setStatus({ phase: 'downloading', availableVersion: status.availableVersion, percent: typeof p.percent === 'number' ? p.percent : 0 });
  });

  deps.autoUpdater.on('update-downloaded', (info: unknown) => {
    const i = (info ?? {}) as { version?: string };
    log('updater: update downloaded', i.version);
    setStatus({ phase: 'downloaded', availableVersion: i.version ?? status.availableVersion });
  });

  deps.autoUpdater.on('error', (error: unknown) => {
    // No published channel file yet → "up to date", not an error. Handled first so it
    // doesn't surface an error toast on every check until the first release ships.
    if (isNoPublishedRelease(error)) {
      log('updater: no channel file published yet — treating as up to date');
      setStatus({ phase: 'up-to-date' });
      return;
    }
    const message = isMissingAppUpdateConfig(error)
      ? 'This build cannot auto-update. Please download the latest release manually.'
      : errorMessage(error);
    log('updater: error', error);
    // Always hand the renderer a manual-download URL so the user has an escape hatch to
    // the GitHub Releases page when auto-update fails.
    setStatus({ phase: 'error', message, errorKey: classifyUpdaterError(error), releasesUrl });
    // Reset the single-flight guard so the user can retry after a failure.
    installing = false;
  });

  return {
    setMainWindow(window) {
      mainWindow = window;
    },

    getStatus() {
      return status;
    },

    async checkForUpdates() {
      try {
        await deps.autoUpdater.checkForUpdates();
      } catch (error) {
        // Most failures arrive via the 'error' event (which set the status already); this
        // catch covers a synchronous throw. Avoid clobbering an error status already set.
        if (status.phase !== 'error' && status.phase !== 'up-to-date') {
          log('updater: checkForUpdates threw', error);
          setStatus({ phase: 'error', message: errorMessage(error), errorKey: classifyUpdaterError(error), releasesUrl });
        }
      }
      return status;
    },

    async downloadAndInstall() {
      if (installing) {
        log('updater: download+install already in flight — ignoring duplicate');
        return { success: true };
      }
      installing = true;
      try {
        setStatus({ phase: 'downloading', availableVersion: status.availableVersion, percent: status.percent ?? 0 });
        await deps.autoUpdater.downloadUpdate();
        // Defer so this IPC response reaches the renderer before the app quits. Stop every
        // engine first (critical difference #2), THEN quitAndInstall — standard Squirrel
        // path on every platform (critical difference #1: notarized Developer ID build).
        scheduleInstall(() => {
          void (async () => {
            try {
              await deps.stopAllEngines();
            } catch (err) {
              log('updater: stopAllEngines before install failed', err);
            }
            try {
              deps.autoUpdater.quitAndInstall();
            } catch (err) {
              log('updater: quitAndInstall failed', err);
              installing = false;
              setStatus({ phase: 'error', message: errorMessage(err), errorKey: classifyUpdaterError(err), releasesUrl });
            }
          })();
        });
        return { success: true };
      } catch (error) {
        installing = false;
        const message = errorMessage(error);
        log('updater: download failed', error);
        setStatus({ phase: 'error', message, errorKey: classifyUpdaterError(error), releasesUrl });
        return { success: false, error: message };
      }
    },

    startPeriodicCheck(intervalHours = 24) {
      if (checkInterval !== null) return;
      // Check immediately on start, then on the interval.
      void this.checkForUpdates();
      checkInterval = setIntervalFn(() => void this.checkForUpdates(), intervalHours * 60 * 60 * 1000);
      log('updater: started periodic checks', intervalHours);
    },

    stopPeriodicCheck() {
      if (checkInterval !== null) {
        clearIntervalFn(checkInterval);
        checkInterval = null;
        log('updater: stopped periodic checks');
      }
    },
  };
}
