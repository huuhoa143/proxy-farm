import { contextBridge, ipcRenderer } from 'electron';
import { createProxyFarmApi } from './api';

/**
 * The renderer talks to main only through this typed surface (spec §3: "No local HTTP
 * API for the UI"). `contextIsolation` is on and `nodeIntegration` is off, so this is
 * the only bridge; `createProxyFarmApi` (unit-tested in api.test.ts) builds exactly the
 * `ProxyFarmApi` shape, nothing else is exposed.
 */
contextBridge.exposeInMainWorld('proxyFarm', createProxyFarmApi(ipcRenderer));
