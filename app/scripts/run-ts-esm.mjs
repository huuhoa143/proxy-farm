// Like run-ts.mjs but bundles to ESM so modules that read import.meta.url load correctly.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const [entry, ...args] = process.argv.slice(2);
const outfile = path.join(tmpdir(), `proxyfarm-${path.basename(entry, '.ts')}.mjs`);
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'warning',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" } });
const { status } = spawnSync(process.execPath, [outfile, ...args], { stdio: 'inherit' });
process.exit(status ?? 1);
