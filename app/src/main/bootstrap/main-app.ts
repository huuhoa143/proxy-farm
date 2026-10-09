/**
 * Composition root (spec §3): the one place every module is instantiated and wired.
 * Order matters and follows the integration checklist:
 *   single-instance lock → translocation guard → paths/resources → secrets → state →
 *   engine check → reap orphans → refusals → providers → engine → port manager → pool →
 *   start queue → facade + IPC → window → tray/power/host-VPN/webhook → restart the
 *   ports that were on → quit handling (stop every engine and wait).
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, safeStorage, session, shell, Tray } from 'electron';
import { autoUpdater } from 'electron-updater';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { networkInterfaces, release as osRelease } from 'node:os';
import path from 'node:path';
import { isTerminalState, portLimitOf, type AppStatus, type PortRow, type PortState, type ProviderId, type Settings, type Target } from '../../shared/contracts';
import { createAccountPool } from '../accounts/pool';
import { createRefusalTracker } from '../accounts/refusals';
import { createRealEngine, reapOrphanedEngines } from '../controller/engine-adapter';
import { createHostVpnMonitor } from '../controller/host-vpn';
import { createPortManager } from '../controller/port-manager';
import { reattachWithAliases } from '../controller/reattach';
import type { Engine } from '../controller/ports';
import { createRealExitIpProber, createRealPortAllocator } from '../controller/real-bindings';
import { createStartQueue } from '../controller/start-queue';
import { assertSingboxVersion, SINGBOX_PINNED_VERSION, singboxPath } from '../engine/singbox-path';
import { PortHealth } from '../health/state-machine';
import { broadcastHostVpnChanged, broadcastPortsChanged, broadcastTargetsChanged, broadcastUpdateStatus, registerIpcHandlers } from '../ipc/index';
import { installPowerHooks, type PowerManager } from '../power/index';
import { getProvider, registerAllProviders } from '../providers/index';
import { migrateKeyLabels } from '../providers/wg-key';
import { setResourcesRoot } from '../resources-root';
import { createStateStore } from '../store/state';
import { createTray, onlineCountLabel, trayLabels, type TrayHandle } from '../tray';
import { resolveRotateKey, startWebhook, type Webhook } from '../webhook/index';
import { aboutPanelOptions, buildAppMenuTemplate, menuLabels } from './app-menu';
import { openExternalIfAllowed } from './external-links';
import { createControllerFacade, rotateNoteKey } from './facade';
import { createSaveExport } from './save-export';
import { createHmaLocalSource } from './hma-local';
import { createHmaCredsSync } from './hma-sync';
import { createHmaWindowsSupport } from './hma-windows';
import { mainStrings, resolveMainLanguage, type MainLanguage } from './main-strings';
import { observeStateStore } from './observed-state';
import { createSessionSecretStore } from './session-secrets';
import { settingsEffects } from './settings-effects';
import { measureDownloadMbps } from './speed-test';
import { createUpdaterService } from './updater';
import { isTranslocatedOrOnDmg } from './translocation';
import { trayIconBitmap } from './tray-icon';

// Vite globals injected by @electron-forge/plugin-vite.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const DEFAULT_WEBHOOK_PORT = 29000;
const QUIT_ARG = '--quit';

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

  // `Proxy Farm --quit` asks a running instance to stop its engines and exit: Windows
  // has no SIGTERM for GUI apps, so scripts and the e2e suite quit it this way.
  const quitRequested = process.argv.includes(QUIT_ARG);

  // 1. single instance — a second launch focuses the existing window (spec §4.3, §6.3).
  if (!app.requestSingleInstanceLock() || quitRequested) {
    app.quit();
    return;
  }

  let mainWindow: BrowserWindow | null = null;
  let showWindow: () => void = () => undefined;
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(QUIT_ARG)) {
      log(`${QUIT_ARG}: quitting`);
      app.quit();
      return;
    }
    showWindow();
  });

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
    // below), everything else → stopped. A terminal failure (login refused, not in plan,
    // key rejected) still holds: it stays, and is not restarted until the user acts.
    rawState.setState((s) => ({
      ...s,
      ports: s.ports.map((p) => ({
        ...p,
        state: p.enabled ? (isTerminalState(p.state) ? p.state : ({ kind: 'queued' } as const)) : ({ kind: 'stopped' } as const),
      })),
      // Key accounts saved by earlier builds were labelled with the end of their PRIVATE
      // key: relabel them after the public key.
      accounts: migrateKeyLabels(s.accounts, (ref) => secrets.loadSecret(ref)),
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
    registerAllProviders({
      surfsharkCachePath: path.join(userData, 'cache', 'surfshark-clusters.json'),
      nordvpnCachePath: path.join(userData, 'cache', 'nordvpn-servers.json'),
      expressvpnPoolPath: path.join(userData, 'cache', 'expressvpn-pools.json'),
    });
    const providers = { get: getProvider };

    // 8. engine: one sing-box per port; `giveUpAfter` read live from settings.
    let shuttingDown = false;
    const realEngine = createRealEngine({
      registryPath,
      binPath: binPath || 'sing-box',
      createPortHealth: (o) => new PortHealth({ ...o, giveUpAfter: () => settingsNow().giveUpAfter }),
    });
    /** Every key with an engine started and not stopped: ports, and credential probes
     * (spec §5.2), which have no port row for the shutdown to find them by. */
    const liveEngineKeys = new Set<string>();
    const engine: Engine = {
      ...realEngine,
      // `opts` carries the port's back-off attempt count: dropping it restarted every
      // back-off at its first 30 s step, so a failing port never backed off.
      start: (key, input, opts) => {
        if (shuttingDown) return Promise.reject(new Error('shutting down'));
        if (engineError) return Promise.reject(new Error(engineError));
        liveEngineKeys.add(key);
        return realEngine.start(key, input, opts);
      },
      stop: (key) => {
        liveEngineKeys.delete(key);
        return realEngine.stop(key);
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
    const pool = createAccountPool({
      listAccounts: () => state.getState().accounts,
      listPorts: () => state.getState().ports,
      setPortAccount: (key, accountId) =>
        state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, accountId } : p)) })),
      getLimit: (providerId) => portLimitOf(state.getState().limits, providerId),
      isUsable: () => true,
      refusals,
    });
    // Owns server-pool failover (spec §6.8), including ZoogVPN plan refusals and moving
    // a refused port to another account of the pool.
    const portManager = createPortManager({
      state,
      secrets,
      engine,
      providers,
      exitIp: createRealExitIpProber(),
      allocator,
      refusals,
      pool,
      // Health marks changed: the picker's "not in your plan" / free counts may be stale.
      onHealthChanged: () => {
        if (mainWindow && !mainWindow.isDestroyed()) broadcastTargetsChanged([mainWindow.webContents]);
      },
    });
    const queue = createStartQueue({ onTaskError: (key, err) => log(`start ${key} failed`, err) });
    /** An automatic restart (app start, resume, a settings change). A terminally failed
     * port is left alone unless `retryTerminal` (its credentials were just replaced). */
    const restartPort = (key: string, opts: { retryTerminal?: boolean } = {}) => {
      const row = state.getState().ports.find((p) => p.key === key);
      if (!row || (isTerminalState(row.state) && !opts.retryTerminal)) return;
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, state: { kind: 'queued' } } : p)) }));
      queue.enqueue(key, () => portManager.startPort(key, opts));
    };
    const onPortState = (cb: (key: string, st: PortState) => void) => engine.onStateChange(cb);

    // HMA local credentials: detection, connect, lazy apply on change (spec §5.1).
    const hma = createHmaLocalSource();
    // Windows: HMA support's task refreshes the readable copy of HMA's credentials (spec §7).
    const hmaWindows = process.platform === 'win32' ? createHmaWindowsSupport({ appExe: process.execPath }) : undefined;
    const hmaSync = createHmaCredsSync({
      source: hma,
      state,
      secrets,
      onPortState,
      // New device credentials: a port refused under the old ones may work now.
      restartPort: (key) => restartPort(key, { retryTerminal: true }),
      onCredentialsChanged: (accountId) => portManager.credentialsChanged(accountId),
    });
    void (hmaWindows?.refresh() ?? Promise.resolve())
      .then(() => hmaSync.check())
      .catch((err) => log('hma credential check failed', err));

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
          resolveKey: (key) => resolveRotateKey(key, state.getState().ports, state.getState().locationAliases),
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

    // Auto-updater (spec §9). Created before the facade (which exposes its check/install
    // over IPC) and before the window (its status pushes go to whatever window is set).
    // `stopAllEngines` here is the full shutdown path: it stops every sing-box engine (so
    // no tunnel is orphaned across the update) and marks cleanup done, so the subsequent
    // quitAndInstall's quit passes straight through `before-quit` instead of being deferred
    // again — letting electron-updater actually install and relaunch.
    const updater = createUpdaterService({
      autoUpdater,
      getAppVersion: () => app.getVersion(),
      broadcast: broadcastUpdateStatus,
      stopAllEngines: async () => {
        await shutdown();
        cleanedUp = true;
      },
      log,
    });

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
      hmaWindows,
      platform: process.platform,
      speedTest: (port, auth) => measureDownloadMbps(port, { auth }),
      saveExport: createSaveExport({
        showSaveDialog: (options) => (mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options)),
        writeFile: (filePath, text) => writeFile(filePath, text, 'utf8'),
        defaultDir: app.getPath('downloads'),
      }),
      appStatus,
      updater,
      diagnosticsEnv: () => ({
        appVersion: app.getVersion(),
        os: { platform: process.platform, release: osRelease(), arch: process.arch },
        versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node },
        // assertSingboxVersion passed at startup, so the bundled binary is the pinned one.
        singBox: engineError ? null : SINGBOX_PINNED_VERSION,
      }),
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
          rebuildMenu();
        }
        if (prev.autoCheckUpdates !== next.autoCheckUpdates) {
          if (next.autoCheckUpdates) updater.startPeriodicCheck(24);
          else updater.stopPeriodicCheck();
        }
      },
    });
    // The webhook is automation, not a user at the keyboard: it must not reset back-off
    // or re-arm a stopped WireGuard key the way the Change-IP button does.
    facadeRotate = async (key) => {
      const result = await portManager.rotatePort(key);
      return { ...result, noteKey: rotateNoteKey(result.noteKey) };
    };

    // IPC: only the main window's own top frame may call in (reviewer item 9).
    registerIpcHandlers(ipcMain, facade, (frame) => Boolean(mainWindow && !mainWindow.isDestroyed() && frame === mainWindow.webContents.mainFrame));

    // App icon for the window / dock / taskbar. On packaged macOS the .icns in
    // the bundle drives the dock, but in `pnpm start` (unpackaged) the dock
    // otherwise shows the generic Electron icon — set it explicitly so the dev
    // run also carries the real logo. Safe no-op if the png isn't found.
    const appIcon = (() => {
      try {
        const img = nativeImage.createFromPath(path.join(process.cwd(), 'icons', 'icon.png'));
        return img.isEmpty() ? null : img;
      } catch {
        return null;
      }
    })();
    if (process.platform === 'darwin' && appIcon) app.dock?.setIcon(appIcon);

    // Content-Security-Policy (defense-in-depth for a credential-handling app).
    // sandbox:false + the preload bridge means any remote page that ever loaded
    // in this window would inherit the full IPC surface, so lock down what can
    // load/execute. Production is strict (scripts from the bundle only); dev is
    // loosened just enough for Vite's HMR (inline/eval + the ws dev channel).
    const isDevServer = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    const csp = isDevServer
      ? "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*; img-src 'self' data:; font-src 'self' data:"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });

    const openExternal = (url: string) => openExternalIfAllowed(url, (u) => shell.openExternal(u), log);

    // Application menu + About panel (Help links go through the same allowlist).
    const APP_NAME = 'Proxy Farm';
    app.setAboutPanelOptions(aboutPanelOptions(APP_NAME, app.getVersion()));
    function rebuildMenu(): void {
      const template = buildAppMenuTemplate({
        platform: process.platform,
        isDev: !app.isPackaged,
        appName: APP_NAME,
        labels: menuLabels(language),
        openLink: (url) => void openExternal(url),
        showAbout: () => app.showAboutPanel(),
      });
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }
    rebuildMenu();

    function createWindow(): void {
      mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        title: 'Proxy Farm',
        // Paint the window in the app's own base colour from the first frame,
        // so launch never flashes an OS-default rectangle while the renderer
        // boots. Follow the OS theme (the renderer defaults to it too, absent a
        // stored override), so the pre-paint colour matches styles.css `--bg`.
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#080b13' : '#eef1f7',
        // Don't show until the renderer has painted its first frame — avoids a
        // blank window hanging on screen during Vite/React startup.
        show: false,
        ...(appIcon ? { icon: appIcon } : {}),
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      mainWindow.once('ready-to-show', () => mainWindow?.show());
      // If first paint never arrives (e.g. a renderer load failure), still
      // surface the window after a short grace period rather than leaving the
      // user staring at nothing — the renderer's own boot fallback then shows.
      const revealGuard = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
      }, 4000);
      mainWindow.once('show', () => clearTimeout(revealGuard));
      // External links (About & help, the updater's "Open releases page" fallback) open
      // in the user's browser, never as a new in-app window — and only when they point
      // at this project's GitHub pages (isAllowedExternalUrl); anything else is dropped.
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
      });
      // Never let the main frame navigate away from the app's own origin — a
      // remote page here would keep this frame's identity and thus the full IPC
      // surface (see CSP note above). Allowlisted external links open in the browser.
      mainWindow.webContents.on('will-navigate', (event, url) => {
        const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL ? url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL) : url.startsWith('file://');
        if (allowed) return;
        event.preventDefault();
        openExternal(url);
      });
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      } else {
        void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
      }
      updater.setMainWindow(mainWindow);
      mainWindow.on('closed', () => {
        mainWindow = null;
        updater.setMainWindow(null);
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
      const keys = new Set([...state.getState().ports.map((p) => p.key), ...liveEngineKeys]);
      await Promise.all([...keys].map((key) => engine.stop(key).catch(() => undefined)));
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
        state.setState((s) => ({
          ...s,
          ports: s.ports.map((p) => (p.enabled && !isTerminalState(p.state) ? { ...p, state: { kind: 'queued' } } : p)),
        }));
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

    // Re-attach ports whose location a provider regrouped since the last run (spec
    // §6.8), before anything starts under a stale key.
    try {
      const byProvider = new Map<ProviderId, Target[]>();
      for (const t of await facade.listTargets()) byProvider.set(t.providerId, [...(byProvider.get(t.providerId) ?? []), t]);
      state.setState((s) => {
        const { ports, aliases } = reattachWithAliases(s.ports, byProvider, s.locationAliases);
        return { ...s, ports, locationAliases: aliases };
      });
    } catch (err) {
      log('re-attaching ports failed', err);
    }

    // Restart what was on at last quit, staggered (spec §6.4 "also on app start").
    portManager.syncAutoRotate();
    if (!engineError) for (const p of state.getState().ports.filter((r) => r.enabled)) restartPort(p.key);

    // Auto-update: check on start + daily, only while the user leaves it enabled (spec §9).
    if (settingsNow().autoCheckUpdates) updater.startPeriodicCheck(24);

    shutdown = async () => {
      shuttingDown = true;
      updater.stopPeriodicCheck();
      portManager.stopAutoRotate();
      hmaSync.dispose();
      hostVpn.stop();
      power?.dispose();
      await webhook?.close().catch(() => undefined);
      await stopAllEngines();
      tray?.destroy();
    };
  });
}
