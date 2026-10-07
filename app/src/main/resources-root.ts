/**
 * Where the app's bundled, read-only resources (CA files, catalogs) live.
 *
 * Providers used to resolve these relative to their own module file via
 * `import.meta.url`, which is only correct when running from source (vitest): once
 * Vite bundles the main process into `.vite/build/index.js`, and especially once the
 * app is packaged (`app.asar` + `Contents/Resources/`), those relative paths point
 * nowhere. The composition root calls `setResourcesRoot()` once at startup
 * (packaged: `process.resourcesPath`, where forge's `packageAfterCopy` hook copies
 * `ca/` and `catalogs/`; dev: `<app>/resources`). Tests never call it and get the
 * source-tree default.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let override: string | undefined;

export function setResourcesRoot(dir: string): void {
  override = dir;
}

/** This file lives at app/src/main/; the resources dir is app/resources. */
function sourceTreeDefault(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../resources');
}

export function resourcesRoot(): string {
  return override ?? sourceTreeDefault();
}

export function resourcePath(...parts: string[]): string {
  return path.join(resourcesRoot(), ...parts);
}
