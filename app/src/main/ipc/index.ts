import { IPC, type PortRow, type ProxyFarmApi } from '../../shared/contracts';

/** The subset of Electron's `ipcMain` this module needs. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
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
 */
export function registerIpcHandlers(ipcMain: IpcMainLike, controller: ControllerFacade): void {
  for (const name of IPC.invoke) {
    ipcMain.handle(name, (_event, ...args) => {
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
