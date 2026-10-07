import { defineConfig } from '@playwright/test';

/**
 * E2E against the PACKAGED app (spec §10): `pnpm run package` first, then
 * `pnpm run test:e2e`. The packaged app has the Node-inspector fuse off, so instead of
 * `_electron.launch()` the harness spawns the real binary with
 * `--remote-debugging-port=0` and attaches over CDP (same approach as lingoreup's
 * packaged pipeline spec).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
});
