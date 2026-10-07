import { contextBridge } from 'electron';

// Empty bridge for now. The renderer talks to main only through this typed
// surface — no HTTP, no nodeIntegration. Later tasks grow this object into
// the full IPC API (providers, ports, health, settings, …) per the design
// spec's §3 "No local HTTP API for the UI" decision.
contextBridge.exposeInMainWorld('proxyFarm', {});
