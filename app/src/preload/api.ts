import { IPC, type ProxyFarmApi } from '../shared/contracts';

/** The slice of `ipcRenderer` this bridge needs, so it can be unit-tested without a
 * real Electron renderer process. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * Builds the exact `ProxyFarmApi` surface (spec §3), every invoke method routed
 * through `ipcRenderer.invoke` on its own channel name, and the two push events
 * subscribed via `ipcRenderer.on`/`removeListener`. `preload/index.ts` passes the real
 * `electron.ipcRenderer` here and hands the result to `contextBridge.exposeInMainWorld`.
 */
export function createProxyFarmApi(ipcRenderer: IpcRendererLike): ProxyFarmApi {
  return {
    listProviders: () => ipcRenderer.invoke('listProviders') as ReturnType<ProxyFarmApi['listProviders']>,
    addAccount: (providerId, input) => ipcRenderer.invoke('addAccount', providerId, input) as ReturnType<ProxyFarmApi['addAccount']>,
    removeAccount: (accountId) => ipcRenderer.invoke('removeAccount', accountId) as ReturnType<ProxyFarmApi['removeAccount']>,
    connectHma: () => ipcRenderer.invoke('connectHma') as ReturnType<ProxyFarmApi['connectHma']>,
    enableHmaSupport: () => ipcRenderer.invoke('enableHmaSupport') as ReturnType<ProxyFarmApi['enableHmaSupport']>,
    importConfigFile: (name, content, country, credentials) =>
      ipcRenderer.invoke('importConfigFile', name, content, country, ...(credentials === undefined ? [] : [credentials])) as ReturnType<
        ProxyFarmApi['importConfigFile']
      >,
    listTargets: (providerId) => ipcRenderer.invoke('listTargets', providerId) as ReturnType<ProxyFarmApi['listTargets']>,

    listServers: (locationKey, portKey) =>
      ipcRenderer.invoke('listServers', locationKey, ...(portKey === undefined ? [] : [portKey])) as ReturnType<ProxyFarmApi['listServers']>,

    listPorts: () => ipcRenderer.invoke('listPorts') as ReturnType<ProxyFarmApi['listPorts']>,
    addPorts: (locationKey, count) => ipcRenderer.invoke('addPorts', locationKey, count) as ReturnType<ProxyFarmApi['addPorts']>,
    startPorts: (targetKeys) => ipcRenderer.invoke('startPorts', targetKeys) as ReturnType<ProxyFarmApi['startPorts']>,
    stopPorts: (targetKeys) => ipcRenderer.invoke('stopPorts', targetKeys) as ReturnType<ProxyFarmApi['stopPorts']>,
    removePorts: (targetKeys) => ipcRenderer.invoke('removePorts', targetKeys) as ReturnType<ProxyFarmApi['removePorts']>,
    rotatePort: (portKey, toServer) => ipcRenderer.invoke('rotatePort', portKey, ...(toServer === undefined ? [] : [toServer])) as ReturnType<ProxyFarmApi['rotatePort']>,
    setAutoRotate: (targetKey, minutes) =>
      ipcRenderer.invoke('setAutoRotate', targetKey, minutes) as ReturnType<ProxyFarmApi['setAutoRotate']>,
    setLimit: (providerId, limit) => ipcRenderer.invoke('setLimit', providerId, limit) as ReturnType<ProxyFarmApi['setLimit']>,
    testPort: (targetKey, speed) => ipcRenderer.invoke('testPort', targetKey, speed) as ReturnType<ProxyFarmApi['testPort']>,
    getLogs: (targetKey) => ipcRenderer.invoke('getLogs', targetKey) as ReturnType<ProxyFarmApi['getLogs']>,
    exportPorts: (targetKeys, format, checks) =>
      ipcRenderer.invoke('exportPorts', targetKeys, format, ...(checks === undefined ? [] : [checks])) as ReturnType<ProxyFarmApi['exportPorts']>,
    saveExportFile: (text, format) => ipcRenderer.invoke('saveExportFile', text, format) as ReturnType<ProxyFarmApi['saveExportFile']>,

    getSettings: () => ipcRenderer.invoke('getSettings') as ReturnType<ProxyFarmApi['getSettings']>,
    setSettings: (patch) => ipcRenderer.invoke('setSettings', patch) as ReturnType<ProxyFarmApi['setSettings']>,
    getHostVpnActive: () => ipcRenderer.invoke('getHostVpnActive') as ReturnType<ProxyFarmApi['getHostVpnActive']>,
    getAppStatus: () => ipcRenderer.invoke('getAppStatus') as ReturnType<ProxyFarmApi['getAppStatus']>,
    getUpdateStatus: () => ipcRenderer.invoke('getUpdateStatus') as ReturnType<ProxyFarmApi['getUpdateStatus']>,
    checkForUpdate: () => ipcRenderer.invoke('checkForUpdate') as ReturnType<ProxyFarmApi['checkForUpdate']>,
    downloadAndInstallUpdate: () =>
      ipcRenderer.invoke('downloadAndInstallUpdate') as ReturnType<ProxyFarmApi['downloadAndInstallUpdate']>,
    getDiagnostics: () => ipcRenderer.invoke('getDiagnostics') as ReturnType<ProxyFarmApi['getDiagnostics']>,

    onPortsChanged: (cb) => {
      const listener = (_event: unknown, rows: unknown) => cb(rows as Parameters<typeof cb>[0]);
      ipcRenderer.on(IPC.events.portsChanged, listener);
      return () => ipcRenderer.removeListener(IPC.events.portsChanged, listener);
    },
    onHostVpnChanged: (cb) => {
      const listener = (_event: unknown, active: unknown) => cb(active as Parameters<typeof cb>[0]);
      ipcRenderer.on(IPC.events.hostVpnChanged, listener);
      return () => ipcRenderer.removeListener(IPC.events.hostVpnChanged, listener);
    },
    onTargetsChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.events.targetsChanged, listener);
      return () => ipcRenderer.removeListener(IPC.events.targetsChanged, listener);
    },
    onUpdateStatus: (cb) => {
      const listener = (_event: unknown, status: unknown) => cb(status as Parameters<typeof cb>[0]);
      ipcRenderer.on(IPC.events.updateStatus, listener);
      return () => ipcRenderer.removeListener(IPC.events.updateStatus, listener);
    },
  };
}
