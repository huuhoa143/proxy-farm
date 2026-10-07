/**
 * Electron main entry. All wiring lives in the composition root
 * (bootstrap/main-app.ts); this file stays a one-liner so the packaged entry point
 * never changes when modules do.
 */
import { runApp } from './bootstrap/main-app';

runApp();
