import { describe, expect, it, vi } from 'vitest';
import { IPC, type PortRow } from '../../shared/contracts';
import { broadcastHostVpnChanged, broadcastPortsChanged, registerIpcHandlers, type ControllerFacade } from './index';

function fakeController(): ControllerFacade {
  return {
    listProviders: vi.fn(async () => []),
    addAccount: vi.fn(async () => ({ ok: true })),
    removeAccount: vi.fn(async () => undefined),
    connectHma: vi.fn(async () => ({ ok: true })),
    importConfigFile: vi.fn(async () => ({ ok: true })),
    listTargets: vi.fn(async () => []),
    listPorts: vi.fn(async () => []),
    startPorts: vi.fn(async () => undefined),
    stopPorts: vi.fn(async () => undefined),
    removePorts: vi.fn(async () => undefined),
    rotatePort: vi.fn(async () => ({ changed: false, noteKey: 'no-server' })),
    setAutoRotate: vi.fn(async () => undefined),
    setLimit: vi.fn(async () => undefined),
    testPort: vi.fn(async () => ({ ok: true })),
    getLogs: vi.fn(async () => []),
    exportPorts: vi.fn(async () => ''),
    getSettings: vi.fn(async () => ({}) as any),
    setSettings: vi.fn(async () => ({}) as any),
    getHostVpnActive: vi.fn(async () => false),
  };
}

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      handlers.set(channel, listener);
    },
    invoke(channel: string, ...args: unknown[]) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler registered for ${channel}`);
      return h({ sender: 'fake' }, ...args);
    },
    channels: () => [...handlers.keys()],
  };
}

describe('ipc registration (spec §3)', () => {
  it('registers exactly one handler per IPC.invoke name', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, fakeController());
    expect(ipcMain.channels().sort()).toEqual([...IPC.invoke].sort());
  });

  it('forwards invoke args to the matching controller method, dropping the event', async () => {
    const ipcMain = fakeIpcMain();
    const controller = fakeController();
    registerIpcHandlers(ipcMain, controller);
    await ipcMain.invoke('rotatePort', 'hma:jp-tok');
    expect(controller.rotatePort).toHaveBeenCalledWith('hma:jp-tok');
  });

  it('forwards multiple args in order', async () => {
    const ipcMain = fakeIpcMain();
    const controller = fakeController();
    registerIpcHandlers(ipcMain, controller);
    await ipcMain.invoke('addAccount', 'zoogvpn', { email: 'a@b.com', password: 'x' });
    expect(controller.addAccount).toHaveBeenCalledWith('zoogvpn', { email: 'a@b.com', password: 'x' });
  });

  it('returns the controller method result through invoke', async () => {
    const ipcMain = fakeIpcMain();
    const controller = fakeController();
    (controller.testPort as any).mockResolvedValueOnce({ ok: true, exitIp: '1.2.3.4' });
    registerIpcHandlers(ipcMain, controller);
    const result = await ipcMain.invoke('testPort', 'key', false);
    expect(result).toEqual({ ok: true, exitIp: '1.2.3.4' });
  });
});

describe('event broadcast (spec §3 push events)', () => {
  it('broadcastPortsChanged sends the rows on the ports-changed channel to every window', () => {
    const w1 = { send: vi.fn() };
    const w2 = { send: vi.fn() };
    const rows: PortRow[] = [];
    broadcastPortsChanged([w1, w2], rows);
    expect(w1.send).toHaveBeenCalledWith(IPC.events.portsChanged, rows);
    expect(w2.send).toHaveBeenCalledWith(IPC.events.portsChanged, rows);
  });

  it('broadcastHostVpnChanged sends the boolean on the host-vpn-changed channel', () => {
    const w1 = { send: vi.fn() };
    broadcastHostVpnChanged([w1], true);
    expect(w1.send).toHaveBeenCalledWith(IPC.events.hostVpnChanged, true);
  });
});
