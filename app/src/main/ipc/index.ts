import { IPC, type PortRow, type ProxyFarmApi } from '../../shared/contracts';

/** The shape of the `event` Electron's `ipcMain.handle` listener is called with — just
 * enough of it (`sender.id`) to check the call came from our own window. */
export interface IpcEventLike {
  sender: { id: number };
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

/** Every invokable method, with the two push-only event methods removed: those are
 * not `ipcMain.handle` calls, they are broadcast via `broadcastPortsChanged` /
 * `broadcastHostVpnChanged` instead (see below). */
export type ControllerFacade = Omit<ProxyFarmApi, 'onPortsChanged' | 'onHostVpnChanged'>;

/**
 * Registers one `ipcMain.handle` per name in `IPC.invoke`, each forwarding to the
 * matching method on `controller`. This is the only place channel names are listed:
 * preload exposes exactly the same set (see `preload/index.ts`), so the two are kept
 * in sync by both reading `IPC.invoke` from the shared contract.
 *
 * `isTrustedSender` checks `event.sender.id` against the app's own window(s) (anything
 * else — a devtools-opened extra frame, a future <webview>, etc. — is rejected). The
 * real wiring at app startup should pass `(id) => id === mainWindow.webContents.id`
 * (or a small allowlist, once more windows exist). Defaults to allowing everything, so
 * tests that don't care about this can omit it.
 */
export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  controller: ControllerFacade,
  isTrustedSender: (senderId: number) => boolean = () => true,
): void {
  for (const name of IPC.invoke) {
    ipcMain.handle(name, (event, ...args) => {
      if (!isTrustedSender(event.sender.id)) {
        // Rejected, not thrown: a real `ipcMain.handle` listener that throws
        // synchronously still crosses the IPC boundary as a rejection on the renderer
        // side, so returning one directly keeps this testable without that boundary.
        return Promise.reject(new Error(`ipc: rejected "${name}" from an untrusted sender (webContents id ${event.sender.id})`));
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
