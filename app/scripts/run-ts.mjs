#!/usr/bin/env node
// Runs a TypeScript maintainer script that imports app source: bundles it with esbuild
// into the OS temp dir, then executes it with the remaining arguments.
//   node scripts/run-ts.mjs scripts/hma-scan-servers.ts --write
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <script.ts> [args...]');
  process.exit(2);
}
const outfile = path.join(tmpdir(), `proxyfarm-${path.basename(entry, '.ts')}.cjs`);
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
  // App modules read `import.meta.url` only as a source-tree fallback; scripts set their
  // paths explicitly (e.g. setResourcesRoot), so the CJS-bundle warning is noise.
  logOverride: { 'empty-import-meta': 'silent' },
});
const { status } = spawnSync(process.execPath, [outfile, ...args], { stdio: 'inherit' });
process.exit(status ?? 1);
