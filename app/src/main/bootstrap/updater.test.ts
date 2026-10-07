import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../shared/contracts';
import { createUpdaterService, isMissingAppUpdateConfig, isNoPublishedRelease, type UpdaterServiceDeps } from './updater';

// ───────────────────────── pure helpers ─────────────────────────

describe('isNoPublishedRelease', () => {
  it('matches the updater channel-file-not-found code', () => {
    expect(isNoPublishedRelease({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })).toBe(true);
  });
  it('matches the older "Cannot find channel … update info" message', () => {
    expect(isNoPublishedRelease({ message: 'Cannot find channel "latest" update info' })).toBe(true);
  });
  it('does NOT match a bare 404 (could be a deleted installer asset — a real failure)', () => {
    expect(isNoPublishedRelease({ message: 'HttpError: 404 Not Found' })).toBe(false);
    expect(isNoPublishedRelease({ code: 'ERR_HTTP' })).toBe(false);
    expect(isNoPublishedRelease(null)).toBe(false);
    expect(isNoPublishedRelease('nope')).toBe(false);
  });
});

describe('isMissingAppUpdateConfig', () => {
  it('matches ENOENT on an app-update.yml path', () => {
    expect(isMissingAppUpdateConfig({ code: 'ENOENT', path: '/a/b/app-update.yml' })).toBe(true);
  });
  it('does not match other ENOENTs or non-objects', () => {
    expect(isMissingAppUpdateConfig({ code: 'ENOENT', path: '/a/other.yml' })).toBe(false);
    expect(isMissingAppUpdateConfig({ code: 'EACCES', path: '/a/app-update.yml' })).toBe(false);
    expect(isMissingAppUpdateConfig(undefined)).toBe(false);
  });
});

// ───────────────────────── fake autoUpdater ─────────────────────────

function fakeAutoUpdater() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    autoDownload: true,
    logger: null as unknown,
    on(event: string, fn: (...args: unknown[]) => void) {
      listeners.set(event, fn);
    },
    emit(event: string, ...args: unknown[]) {
      const fn = listeners.get(event);
      if (!fn) throw new Error(`no listener for ${event}`);
      fn(...args);
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => ['/tmp/ProxyFarm.zip']),
    quitAndInstall: vi.fn(),
  };
}

function setup(overrides: Partial<UpdaterServiceDeps> = {}) {
  const au = fakeAutoUpdater();
  const statuses: UpdateStatus[] = [];
  const order: string[] = [];
  const stopAllEngines = vi.fn(async () => {
    order.push('stop');
  });
  au.quitAndInstall.mockImplementation(() => order.push('install'));
  const installCbs: Array<() => void> = [];
  const svc = createUpdaterService({
    autoUpdater: au,
    getAppVersion: () => '1.0.0',
    broadcast: (_windows, status) => statuses.push(status),
    stopAllEngines,
    scheduleInstall: (fn) => installCbs.push(fn),
    log: () => undefined,
    ...overrides,
  });
  svc.setMainWindow({ isDestroyed: () => false, webContents: { send: () => undefined } });
  return { svc, au, statuses, stopAllEngines, installCbs, order };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('UpdaterService construction', () => {
  it('forces autoDownload off (download+install stays user-initiated)', () => {
    const { au } = setup();
    expect(au.autoDownload).toBe(false);
  });
});

describe('UpdaterService status transitions', () => {
  it('checking-for-update → phase checking with the current version', () => {
    const { svc, au, statuses } = setup();
    au.emit('checking-for-update');
    expect(svc.getStatus()).toEqual({ phase: 'checking', currentVersion: '1.0.0' });
    expect(statuses.at(-1)).toEqual({ phase: 'checking', currentVersion: '1.0.0' });
  });

  it('update-available → phase available with version + notes', () => {
    const { svc, au } = setup();
    au.emit('update-available', { version: '2.0.0', releaseNotes: 'stuff' });
    expect(svc.getStatus()).toMatchObject({ phase: 'available', availableVersion: '2.0.0', notes: 'stuff' });
  });

  it('update-not-available → phase up-to-date', () => {
    const { svc, au } = setup();
    au.emit('update-not-available', { version: '1.0.0' });
    expect(svc.getStatus().phase).toBe('up-to-date');
  });

  it('download-progress → phase downloading with percent', () => {
    const { svc, au } = setup();
    au.emit('update-available', { version: '2.0.0' });
    au.emit('download-progress', { percent: 42.5 });
    expect(svc.getStatus()).toMatchObject({ phase: 'downloading', percent: 42.5, availableVersion: '2.0.0' });
  });

  it('update-downloaded → phase downloaded', () => {
    const { svc, au } = setup();
    au.emit('update-downloaded', { version: '2.0.0' });
    expect(svc.getStatus()).toMatchObject({ phase: 'downloaded', availableVersion: '2.0.0' });
  });

  it('a no-published-release error is treated as up-to-date, not an error', () => {
    const { svc, au } = setup();
    au.emit('error', { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    expect(svc.getStatus().phase).toBe('up-to-date');
  });

  it('a missing app-update.yml error → phase error with a releases URL', () => {
    const { svc, au } = setup();
    au.emit('error', { code: 'ENOENT', path: '/x/app-update.yml' });
    const s = svc.getStatus();
    expect(s.phase).toBe('error');
    expect(s.releasesUrl).toMatch(/github\.com/);
    expect(s.message).toMatch(/manually/i);
  });

  it('a generic error → phase error with the message and a releases URL fallback', () => {
    const { svc, au } = setup();
    au.emit('error', new Error('network down'));
    expect(svc.getStatus()).toMatchObject({ phase: 'error', message: 'network down' });
    expect(svc.getStatus().releasesUrl).toMatch(/github\.com/);
  });
});

describe('UpdaterService checkForUpdates', () => {
  it('calls autoUpdater.checkForUpdates and returns the resulting status', async () => {
    const { svc, au } = setup();
    au.checkForUpdates.mockImplementation(async () => {
      au.emit('update-not-available', {});
      return undefined;
    });
    const result = await svc.checkForUpdates();
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe('up-to-date');
  });

  it('a synchronous check throw (no error event) surfaces as an error status', async () => {
    const { svc, au } = setup();
    au.checkForUpdates.mockRejectedValueOnce(new Error('boom'));
    const result = await svc.checkForUpdates();
    expect(result).toMatchObject({ phase: 'error', message: 'boom' });
  });
});

describe('UpdaterService downloadAndInstall', () => {
  it('downloads, then stops all engines BEFORE quitAndInstall', async () => {
    const { svc, au, installCbs, order, stopAllEngines } = setup();
    au.emit('update-available', { version: '2.0.0' });
    const res = await svc.downloadAndInstall();
    expect(res).toEqual({ success: true });
    expect(au.downloadUpdate).toHaveBeenCalledTimes(1);
    // Install is deferred so the IPC response returns first.
    expect(au.quitAndInstall).not.toHaveBeenCalled();
    installCbs[0]();
    await flush();
    expect(stopAllEngines).toHaveBeenCalledTimes(1);
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['stop', 'install']);
  });

  it('is single-flight: a second call while installing does not re-download', async () => {
    const { svc, au } = setup();
    await svc.downloadAndInstall();
    await svc.downloadAndInstall();
    expect(au.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('a failed download resets the guard and reports the error (retryable)', async () => {
    const { svc, au } = setup();
    au.downloadUpdate.mockRejectedValueOnce(new Error('offline'));
    const res = await svc.downloadAndInstall();
    expect(res).toEqual({ success: false, error: 'offline' });
    expect(svc.getStatus()).toMatchObject({ phase: 'error', message: 'offline' });
    // Guard reset → a retry actually re-downloads.
    await svc.downloadAndInstall();
    expect(au.downloadUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('UpdaterService periodic checks', () => {
  it('startPeriodicCheck checks immediately then registers an interval; stop clears it', () => {
    const setIntervalFn = vi.fn((_fn: () => void, _ms: number) => 'handle');
    const clearIntervalFn = vi.fn();
    const { svc, au } = setup({ setInterval: setIntervalFn, clearInterval: clearIntervalFn });
    svc.startPeriodicCheck(24);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0][1]).toBe(24 * 60 * 60 * 1000);
    // Idempotent: a second start does not register a second interval.
    svc.startPeriodicCheck(24);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    svc.stopPeriodicCheck();
    expect(clearIntervalFn).toHaveBeenCalledWith('handle');
  });

  it('the interval callback runs another check', () => {
    let tick: () => void = () => undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      tick = fn;
      return 'h';
    });
    const { svc, au } = setup({ setInterval: setIntervalFn, clearInterval: vi.fn() });
    svc.startPeriodicCheck(24);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    tick();
    expect(au.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
