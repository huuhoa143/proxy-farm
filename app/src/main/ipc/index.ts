import { IPC, type PortRow, type ProxyFarmApi, type UpdateStatus } from '../../shared/contracts';

/** The shape of the `event` Electron's `ipcMain.handle` listener is called with. Trust
 * decisions use `senderFrame` (Electron's `WebFrameMain`), not `sender.id`/`sender`:
 * `sender` identifies the whole `WebContents` (the top-level page), but a compromised
 * or malicious *subframe* embedded in that same page (a devtools extension, a stray
 * `<iframe>`, a future `<webview>`) shares the same `sender.id` while being a distinct,
 * untrusted `senderFrame` — only a same-origin check against the main window's own main
 * frame actually rules that out (reviewer item 9). `sender` is kept only for the
 * rejection message's diagnostics. */
export interface IpcEventLike {
  sender: { id: number };
  senderFrame: unknown;
}

/** The subset of Electron's `ipcMain` this module needs. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
}

/** The subset of a `BrowserWindow`'s `webContents` this module needs. */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

/** Every invokable method, with the push-only event methods removed: those are not
 * `ipcMain.handle` calls, they are broadcast via `broadcastPortsChanged` /
 * `broadcastHostVpnChanged` / `broadcastUpdateStatus` instead (see below). */
export type ControllerFacade = Omit<ProxyFarmApi, 'onPortsChanged' | 'onHostVpnChanged' | 'onUpdateStatus'>;

/**
 * Registers one `ipcMain.handle` per name in `IPC.invoke`, each forwarding to the
 * matching method on `controller`. This is the only place channel names are listed:
 * preload exposes exactly the same set (see `preload/index.ts`), so the two are kept
 * in sync by both reading `IPC.invoke` from the shared contract.
 *
 * `isTrustedFrame` checks `event.senderFrame` — Electron's `WebFrameMain` for the frame
 * that actually made the call — against the app's own main window's main frame (anything
 * else, e.g. a devtools-opened extra frame or a future `<webview>`'s guest frame, is
 * rejected even though it may share the same top-level `sender`). The real wiring at
 * app startup should pass `(frame) => frame === mainWindow.webContents.mainFrame` (or a
 * small allowlist, once more windows exist). Defaults to allowing everything, so tests
 * that don't care about this can omit it.
 */
export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  controller: ControllerFacade,
  isTrustedFrame: (senderFrame: unknown) => boolean = () => true,
): void {
  for (const name of IPC.invoke) {
    ipcMain.handle(name, (event, ...args) => {
      if (!isTrustedFrame(event.senderFrame)) {
        // Rejected, not thrown: a real `ipcMain.handle` listener that throws
        // synchronously still crosses the IPC boundary as a rejection on the renderer
        // side, so returning one directly keeps this testable without that boundary.
        return Promise.reject(new Error(`ipc: rejected "${name}" from an untrusted frame (webContents id ${event.sender.id})`));
      }
      const method = controller[name] as (...a: unknown[]) => unknown;
      return method.apply(controller, args);
    });
  }
}

/** Push the current port rows to every open window (spec §3's "push events"). Call
 * this after any mutation that changes `ports` (start/stop/rotate/remove/...). */
export function broadcastPortsChanged(windows: Iterable<WebContentsLike>, rows: PortRow[]): void {
  for (const w of windows) w.send(IPC.events.portsChanged, rows);
}

/** Push a host-VPN-detector transition to every open window (spec §4.3). */
export function broadcastHostVpnChanged(windows: Iterable<WebContentsLike>, active: boolean): void {
  for (const w of windows) w.send(IPC.events.hostVpnChanged, active);
}

/** Push an auto-update status to every open window (spec §9). Called by the
 * `UpdaterService` on every state transition (check/available/progress/installed/error). */
export function broadcastUpdateStatus(windows: Iterable<WebContentsLike>, status: UpdateStatus): void {
  for (const w of windows) w.send(IPC.events.updateStatus, status);
}
