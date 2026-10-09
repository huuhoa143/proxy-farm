import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../shared/contracts';
import { createProxyFarmApi, type IpcRendererLike } from './api';

function fakeIpcRenderer(): IpcRendererLike & { listeners: Map<string, Set<(...a: any[]) => void>> } {
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  return {
    listeners,
    invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => undefined),
    on: vi.fn((channel: string, listener: (...a: any[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel: string, listener: (...a: any[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
}

describe('preload API surface (spec §3)', () => {
  it('exposes exactly the IPC.invoke methods plus the two event subscriptions — no more, no less', () => {
    const api = createProxyFarmApi(fakeIpcRenderer());
    const expected = new Set([...IPC.invoke, 'onPortsChanged', 'onHostVpnChanged', 'onTargetsChanged', 'onUpdateStatus']);
    expect(new Set(Object.keys(api))).toEqual(expected);
  });

  it('every property is a function', () => {
    const api = createProxyFarmApi(fakeIpcRenderer());
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a function`).toBe('function');
    }
  });

  it('routes each invoke method to ipcRenderer.invoke on its own channel with args forwarded', async () => {
    const ipc = fakeIpcRenderer();
    const api = createProxyFarmApi(ipc);

    await api.rotatePort('hma:jp-tok');
    expect(ipc.invoke).toHaveBeenCalledWith('rotatePort', 'hma:jp-tok');

    await api.addAccount('zoogvpn', { email: 'a@b.com', password: 'x' });
    expect(ipc.invoke).toHaveBeenCalledWith('addAccount', 'zoogvpn', { email: 'a@b.com', password: 'x' });

    await api.setSettings({ keepAwake: false });
    expect(ipc.invoke).toHaveBeenCalledWith('setSettings', { keepAwake: false });

    await api.listProviders();
    expect(ipc.invoke).toHaveBeenCalledWith('listProviders');

    await api.listServers('hma:jp-tok', 'hma:jp-tok#2');
    expect(ipc.invoke).toHaveBeenCalledWith('listServers', 'hma:jp-tok', 'hma:jp-tok#2');
    await api.listServers('hma:jp-tok');
    expect(ipc.invoke).toHaveBeenLastCalledWith('listServers', 'hma:jp-tok');

    await api.exportPorts(['a#1'], 'csv', { 'a#1': { ok: true, latencyMs: 9 } });
    expect(ipc.invoke).toHaveBeenLastCalledWith('exportPorts', ['a#1'], 'csv', { 'a#1': { ok: true, latencyMs: 9 } });
    await api.exportPorts(['a#1'], 'hostPort');
    expect(ipc.invoke).toHaveBeenLastCalledWith('exportPorts', ['a#1'], 'hostPort');

    await api.saveExportFile('text', 'csv');
    expect(ipc.invoke).toHaveBeenLastCalledWith('saveExportFile', 'text', 'csv');
  });

  it('onPortsChanged subscribes on the right channel and unwraps the event arg', () => {
    const ipc = fakeIpcRenderer();
    const api = createProxyFarmApi(ipc);
    const cb = vi.fn();
    const unsubscribe = api.onPortsChanged(cb);

    expect(ipc.listeners.get(IPC.events.portsChanged)?.size).toBe(1);
    for (const listener of ipc.listeners.get(IPC.events.portsChanged) ?? []) {
      listener({}, [{ key: 'a' }]);
    }
    expect(cb).toHaveBeenCalledWith([{ key: 'a' }]);

    unsubscribe();
    expect(ipc.listeners.get(IPC.events.portsChanged)?.size).toBe(0);
  });

  it('onHostVpnChanged subscribes on the right channel and unwraps the event arg', () => {
    const ipc = fakeIpcRenderer();
    const api = createProxyFarmApi(ipc);
    const cb = vi.fn();
    const unsubscribe = api.onHostVpnChanged(cb);

    for (const listener of ipc.listeners.get(IPC.events.hostVpnChanged) ?? []) {
      listener({}, true);
    }
    expect(cb).toHaveBeenCalledWith(true);
    unsubscribe();
    expect(ipc.listeners.get(IPC.events.hostVpnChanged)?.size).toBe(0);
  });

  it('onTargetsChanged subscribes on the targets-changed channel', () => {
    const ipc = fakeIpcRenderer();
    const api = createProxyFarmApi(ipc);
    const cb = vi.fn();
    const unsubscribe = api.onTargetsChanged(cb);
    for (const listener of ipc.listeners.get(IPC.events.targetsChanged) ?? []) listener({});
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(ipc.listeners.get(IPC.events.targetsChanged)?.size).toBe(0);
  });
});
