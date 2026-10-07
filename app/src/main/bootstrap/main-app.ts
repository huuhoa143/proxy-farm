/**
 * Composition root (spec §3): the one place every module is instantiated and wired.
 * Order matters and follows the integration checklist:
 *   single-instance lock → translocation guard → paths/resources → secrets → state →
 *   engine check → reap orphans → refusals → providers → engine → port manager → pool →
 *   start queue → facade + IPC → window → tray/power/host-VPN/webhook → restart the
 *   ports that were on → quit handling (stop every engine and wait).
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, Tray } from 'electron';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import type { AppStatus, PortRow, PortState, Settings } from '../../shared/contracts';
import { createAccountPool } from '../accounts/pool';
import { createRefusalTracker } from '../accounts/refusals';
import { createRealEngine, reapOrphanedEngines } from '../controller/engine-adapter';
import { createHostVpnMonitor } from '../controller/host-vpn';
import { createPortManager } from '../controller/port-manager';
import type { Engine } from '../controller/ports';
import { createRealExitIpProber, createRealPortAllocator } from '../controller/real-bindings';
import { createStartQueue } from '../controller/start-queue';
import { assertSingboxVersion, singboxPath } from '../engine/singbox-path';
import { PortHealth } from '../health/state-machine';
import { broadcastHostVpnChanged, broadcastPortsChanged, registerIpcHandlers } from '../ipc/index';
import { installPowerHooks, type PowerManager } from '../power/index';
import { getProvider, registerAllProviders } from '../providers/index';
import { setResourcesRoot } from '../resources-root';
import { createStateStore } from '../store/state';
import { createTray, onlineCountLabel, trayLabels, type TrayHandle } from '../tray';
import { startWebhook, type Webhook } from '../webhook/index';
import { createControllerFacade } from './facade';
import { createHmaLocalSource } from './hma-local';
import { createHmaCredsSync } from './hma-sync';
import { mainStrings, resolveMainLanguage, type MainLanguage } from './main-strings';
import { observeStateStore } from './observed-state';
import { wireRefusals } from './refusal-wiring';
import { createSessionSecretStore } from './session-secrets';
import { settingsEffects } from './settings-effects';
import { measureDownloadMbps } from './speed-test';
import { isTranslocatedOrOnDmg } from './translocation';
import { trayIconBitmap } from './tray-icon';

// Vite globals injected by @electron-forge/plugin-vite.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const DEFAULT_WEBHOOK_PORT = 29000;

function log(msg: string, err?: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`[proxy-farm] ${msg}`, err instanceof Error ? err.message : (err ?? ''));
  } catch {
    // stdout gone (launcher exited): logging must never take the app down
  }
}

// When whoever launched us goes away, writes to stdout/stderr fail with EPIPE. Those
// surface as async 'error' events; unhandled, they became uncaught exceptions and left
// the main process in a state where the first SIGTERM/quit was swallowed (found in e2e).
for (const stream of [process.stdout, process.stderr]) stream?.on?.('error', () => undefined);

function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

/** spec §9: offer to move a DMG-launched / translocated app into /Applications. */
async function translocationGuard(lang: MainLanguage): Promise<void> {
  if (!app.isPackaged || process.platform !== 'darwin') return;
  if (!isTranslocatedOrOnDmg(app.getPath('exe'))) return;
  const s = mainStrings(lang);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: s.moveTitle,
    detail: `${s.moveMessage}\n\n${s.moveDetail}`,
    buttons: [s.moveNow, s.moveLater],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder(); // relaunches from /Applications on success
  } catch (err) {
    log('moveToApplicationsFolder failed', err);
    await dialog.showMessageBox({ type: 'warning', message: s.moveFailed });
  }
}

export function runApp(): void {
  // Test/dev hook: an isolated profile (e2e runs, a second dev copy). Must run before
  // the single-instance lock, which is scoped to the userData dir.
  const userDataOverride = process.env.PROXYFARM_USER_DATA_DIR;
  if (userDataOverride) app.setPath('userData', userDataOverride);

  // 1. single instance — a second launch focuses the existing window (spec §4.3, §6.3).
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let mainWindow: BrowserWindow | null = null;
  let showWindow: () => void = () => undefined;
  app.on('second-instance', () => showWindow());

  // Stop every engine and wait before the process exits (spec §6.3) — also the hook a
  // future electron-updater `quitAndInstall` must await first.
  let shutdown: () => Promise<void> = async () => undefined;
  let cleanedUp = false;
  let quitting = false;
  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    log('quitting: stopping all engines');
    void shutdown()
      .catch((err) => log('shutdown failed', err))
      .finally(() => {
        log('engines stopped; exiting');
        cleanedUp = true;
        // app.exit, not app.quit: when the quit came from Electron's own SIGTERM
        // handling, a second app.quit() after the deferred cleanup was ignored and the
        // process lingered (found in e2e). Everything that needed a graceful stop is done.
        app.exit(0);
      });
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(sig, () => {
      log(`${sig}: quitting`);
      app.quit();
    });
  // A tray app that runs proxies unattended must never freeze behind Electron's modal
  // "JavaScript error in the main process" dialog (it blocks the event loop, so every
  // port and IPC call stalls). Log instead; the failing port's own state handles retry.
  process.on('uncaughtException', (err) => {
    if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return;
    log('uncaught exception', err);
  });
  process.on('unhandledRejection', (err) => log('unhandled rejection', err));

  // Ports keep running with the window closed; quit from the tray or the app menu.
  app.on('window-all-closed', () => undefined);

  void app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    mkdirSync(userData, { recursive: true });
    setResourcesRoot(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'));

    // 2-3. secrets (safeStorage, in-memory fallback) + state.
    const secrets = createSessionSecretStore(safeStorage, path.join(userData, 'secrets'));
    const rawState = createStateStore(path.join(userData, 'state.json'), secrets);
    const settingsNow = (): Settings => rawState.getState().settings;
    let language = resolveMainLanguage(settingsNow().language, app.getLocale());

    await translocationGuard(language);

    // A previous session's live states are meaningless now: enabled → queued (restarted
    // below), everything else → stopped.
    rawState.setState((s) => ({
      ...s,
      ports: s.ports.map((p) => ({ ...p, state: p.enabled ? ({ kind: 'queued' } as const) : ({ kind: 'stopped' } as const) })),
    }));

    // 4. sing-box present, runnable (not quarantined) and the pinned version — or a
    // clear error screen instead of a crash.
    let engineError: string | undefined;
    let binPath = '';
    try {
      binPath = singboxPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: app.getAppPath() });
      await assertSingboxVersion(binPath);
    } catch (err) {
      engineError = err instanceof Error ? err.message : String(err);
      log('engine check failed', err);
    }

    // 5. reap sing-box processes orphaned by a crash, BEFORE anything starts.
    const registryPath = path.join(userData, 'pids.json');
    try {
      const reaped = await reapOrphanedEngines(registryPath);
      if (reaped > 0) log(`reaped ${reaped} orphaned engine process(es)`);
    } catch (err) {
      log('orphan reaping failed', err);
    }

    // 6. ONE refusal tracker, shared by port manager and pool.
    const refusals = createRefusalTracker({ initial: rawState.getState().refusals });

    // 7. providers.
    registerAllProviders({ surfsharkCachePath: path.join(userData, 'cache', 'surfshark-clusters.json') });
    const providers = { get: getProvider };

    // 8. engine: one sing-box per port; `giveUpAfter` read live from settings.
    let shuttingDown = false;
    const realEngine = createRealEngine({
      registryPath,
      binPath: binPath || 'sing-box',
      createPortHealth: (o) => new PortHealth({ ...o, giveUpAfter: settingsNow().giveUpAfter }),
    });
    const engine: Engine = {
      ...realEngine,
      start: (key, input) => {
        if (shuttingDown) return Promise.reject(new Error('shutting down'));
        if (engineError) return Promise.reject(new Error(engineError));
        return realEngine.start(key, input);
      },
    };

    // ports-changed push: renderer, tray count, keep-awake — whoever changed the rows.
    let tray: TrayHandle | undefined;
    let power: PowerManager | undefined;
    const onPortsChanged = (rows: PortRow[]) => {
      if (mainWindow && !mainWindow.isDestroyed()) broadcastPortsChanged([mainWindow.webContents], rows);
      tray?.setOnlineCount(rows.filter((r) => r.state.kind === 'online').length);
      power?.refreshKeepAwake();
    };
    const state = observeStateStore(rawState, onPortsChanged);

    const allocator = createRealPortAllocator();
    const portManager = createPortManager({
      state,
      secrets,
      engine,
      providers,
      exitIp: createRealExitIpProber(),
      allocator,
      refusals,
    });
    const pool = createAccountPool({
      listAccounts: () => state.getState().accounts,
      listPorts: () => state.getState().ports,
      setPortAccount: (key, accountId) =>
        state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, accountId } : p)) })),
      getLimit: (providerId) => state.getState().limits[providerId] ?? 0,
      isUsable: () => true,
      refusals,
    });
    const queue = createStartQueue({ onTaskError: (key, err) => log(`start ${key} failed`, err) });
    const restartPort = (key: string) => {
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, state: { kind: 'queued' } } : p)) }));
      queue.enqueue(key, () => portManager.startPort(key));
    };
    const onPortState = (cb: (key: string, st: PortState) => void) => engine.onStateChange(cb);
    wireRefusals({ state, refusals, pool, onPortState, restartPort });

    // HMA local credentials: detection, connect, lazy apply on change (spec §5.1).
    const hma = createHmaLocalSource();
    const hmaSync = createHmaCredsSync({ source: hma, state, secrets, onPortState, restartPort });
    void hmaSync.check().catch((err) => log('hma credential check failed', err));

    // Webhook (spec §6.6): only while enabled; rebuilt on LAN/webhook changes.
    let webhook: Webhook | undefined;
    let facadeRotate: (key: string) => Promise<import('../../shared/contracts').RotateResult> = async () => ({ changed: false });
    async function applyWebhook(): Promise<void> {
      await webhook?.close().catch(() => undefined);
      webhook = undefined;
      const s = settingsNow();
      if (!s.webhook.enabled || !s.webhook.bearer) return;
      const lan = s.lanSharing && Boolean(s.proxyUser && s.proxyPass);
      const lanIp = lan ? firstLanIPv4() : undefined;
      try {
        webhook = await startWebhook({
          host: lan ? '0.0.0.0' : '127.0.0.1',
          port: s.webhook.port || DEFAULT_WEBHOOK_PORT,
          bearer: s.webhook.bearer,
          hostAllowlist: ['127.0.0.1', 'localhost', ...(lanIp ? [lanIp] : [])],
          rotate: (key) => facadeRotate(key),
        });
      } catch (err) {
        log('webhook failed to start', err);
      }
    }

    const hostVpn = createHostVpnMonitor();

    const appStatus = (): AppStatus => {
      const notice = rawState.takeSecretNotice() ?? undefined;
      return { secretsUnavailable: secrets.unavailable || rawState.secretsUnavailable(), engineError, notice };
    };

    const facade = createControllerFacade({
      state,
      secrets,
      providers,
      portManager,
      pool,
      queue,
      allocator,
      engineLogs: (key) => engine.getLogs(key),
      hostVpn,
      hma,
      platform: process.platform,
      speedTest: (port, auth) => measureDownloadMbps(port, { auth }),
      appStatus,
      log,
      onSettingsChanged: async (prev, next) => {
        const fx = settingsEffects(prev, next);
        if (fx.restartPorts) for (const p of state.getState().ports.filter((r) => r.enabled)) restartPort(p.key);
        if (fx.restartWebhook) await applyWebhook();
        if (fx.refreshKeepAwake) power?.refreshKeepAwake();
        if (fx.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
        if (fx.language) {
          language = resolveMainLanguage(next.language, app.getLocale());
          rebuildTray();
        }
      },
    });
    facadeRotate = (key) => facade.rotatePort(key);

    // IPC: only the main window's own top frame may call in (reviewer item 9).
    registerIpcHandlers(ipcMain, facade, (frame) => Boolean(mainWindow && !mainWindow.isDestroyed() && frame === mainWindow.webContents.mainFrame));

    function createWindow(): void {
      mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        title: 'Proxy Farm',
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      } else {
        void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
      }
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    }
    showWindow = () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    };
    app.on('activate', () => showWindow());
    createWindow();

    async function stopAllEngines(): Promise<void> {
      queue.clear();
      await Promise.all(state.getState().ports.map((p) => engine.stop(p.key).catch(() => undefined)));
    }

    // Tray (spec §4.3).
    function rebuildTray(): void {
      tray?.destroy();
      const icon = nativeImage.createFromBitmap(trayIconBitmap(32), { width: 32, height: 32, scaleFactor: 2 });
      if (process.platform === 'darwin') icon.setTemplateImage(true);
      tray = createTray({
        Tray: Tray as unknown as new (icon: unknown) => import('../tray').TrayLike,
        Menu,
        icon,
        initialOnlineCount: state.getState().ports.filter((r) => r.state.kind === 'online').length,
        labels: trayLabels(language),
        formatOnlineCount: (n) => onlineCountLabel(language, n),
        onShow: () => showWindow(),
        onStopAll: () => void facade.stopPorts(state.getState().ports.filter((p) => p.enabled).map((p) => p.key)),
        onQuit: () => app.quit(),
      });
    }
    rebuildTray();

    // Power (spec §6.7): keep-awake while any port is on; suspend → stop; resume →
    // staggered restart of the ports that were on (enabled stays true across suspend).
    power = installPowerHooks({
      powerMonitor,
      powerSaveBlocker,
      isKeepAwakeEnabled: () => settingsNow().keepAwake,
      hasEnabledPorts: () => state.getState().ports.some((p) => p.enabled),
      listEnabledPortKeys: () => state.getState().ports.filter((p) => p.enabled).map((p) => p.key),
      stopAllPorts: async () => {
        await stopAllEngines();
        state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.enabled ? { ...p, state: { kind: 'queued' } } : p)) }));
      },
      enqueueStart: (key) => restartPort(key),
    });
    power.refreshKeepAwake();

    // Host VPN note (spec §4.3).
    hostVpn.onChange((active) => {
      if (mainWindow && !mainWindow.isDestroyed()) broadcastHostVpnChanged([mainWindow.webContents], active);
    });
    hostVpn.start();

    await applyWebhook();

    // Restart what was on at last quit, staggered (spec §6.4 "also on app start").
    portManager.syncAutoRotate();
    if (!engineError) for (const p of state.getState().ports.filter((r) => r.enabled)) restartPort(p.key);

    shutdown = async () => {
      shuttingDown = true;
      hmaSync.dispose();
      hostVpn.stop();
      power?.dispose();
      await webhook?.close().catch(() => undefined);
      await stopAllEngines();
      tray?.destroy();
    };
  });
}
