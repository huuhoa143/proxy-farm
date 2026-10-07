#!/usr/bin/env node
// Fetches the pinned sing-box release binary for the host platform (or all
// three platforms with --all) into app/resources/sing-box/<platform-arch>/,
// verifying each download against the sha256 pinned in singbox.pins.json
// before extracting it, and verifying the *extracted* binary against its own
// pinned sha256 afterwards. Also fetches the matching sing-box source
// tarball into app/resources/sing-box-src/ (GPLv3 §6 — every release
// attaches it).
//
// Usage:
//   node scripts/prebuild-singbox.mjs          # host platform only
//   node scripts/prebuild-singbox.mjs --all     # all three pinned platforms
//   node scripts/prebuild-singbox.mjs --force   # ignore cache, re-fetch

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, copyFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import extractZip from 'extract-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(APP_ROOT, 'resources');
const PINS_PATH = path.join(__dirname, 'singbox.pins.json');
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Verifies that the file at `filePath` hashes (sha256) to `expectedHex`.
 * Resolves `true` on match; throws on mismatch. Hex comparison is
 * case-insensitive.
 */
export async function verifySha256(filePath, expectedHex) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  const actual = hash.digest('hex');
  const expected = String(expectedHex).toLowerCase();
  if (actual.toLowerCase() !== expected) {
    throw new Error(`sha256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
  }
  return true;
}

/** Non-throwing variant of verifySha256, used for cache-hit checks: missing
 * file, read error, or hash mismatch are all just "not cached". */
async function fileMatchesSha256(filePath, expectedHex) {
  if (!existsSync(filePath)) return false;
  try {
    return await verifySha256(filePath, expectedHex);
  } catch {
    return false;
  }
}

export async function loadPins() {
  const raw = await readFile(PINS_PATH, 'utf8');
  return JSON.parse(raw);
}

/** Maps the running host's platform/arch to a sing-box release asset key. */
export function hostPlatformKey() {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-amd64';
  if (platform === 'win32' && arch === 'x64') return 'windows-amd64';
  throw new Error(
    `No pinned sing-box asset for host platform "${platform}-${arch}". ` +
      'Supported: darwin-arm64, darwin-amd64, windows-amd64.',
  );
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function findFileRecursive(dir, fileName) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return null;
}

/** Extracts a single named binary out of a .tar.gz, stripping the top-level dir. */
async function extractTarGzBinary(archivePath, targetDir, binaryName) {
  await mkdir(targetDir, { recursive: true });
  await tar.x({
    file: archivePath,
    cwd: targetDir,
    strip: 1,
    filter: (entryPath) => entryPath.endsWith(binaryName),
  });
  const binPath = path.join(targetDir, binaryName);
  if (!existsSync(binPath)) {
    throw new Error(`Expected "${binaryName}" not found after extracting ${archivePath}`);
  }
  return binPath;
}

/** Extracts a single named binary out of a .zip (whole archive extracted to a scratch dir first). */
async function extractZipBinary(archivePath, targetDir, binaryName) {
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'pf-singbox-zip-'));
  try {
    await extractZip(archivePath, { dir: scratchDir });
    const found = await findFileRecursive(scratchDir, binaryName);
    if (!found) {
      throw new Error(`Expected "${binaryName}" not found after extracting ${archivePath}`);
    }
    await mkdir(targetDir, { recursive: true });
    const dest = path.join(targetDir, binaryName);
    await copyFile(found, dest);
    return dest;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Fetches, verifies and extracts the pinned sing-box asset for `platformKey`
 * (e.g. "darwin-arm64") into `<resourcesDir>/sing-box/<platformKey>/`.
 *
 * Cache behaviour: if a binary already sits at the target path, it is
 * re-hashed (not merely checked for existence, and not trusted via a
 * sidecar file) against the pinned `binarySha256` on every call. A match
 * skips the network round-trip entirely; a mismatch (tampered, corrupted,
 * or stale from an older pin) deletes it and falls through to a full
 * re-fetch. `--force` always re-fetches, skipping the cache check.
 *
 * `download` is injectable (defaults to the real HTTP fetch) so tests can
 * exercise the cache/re-fetch branching without hitting the network.
 */
export async function fetchPlatform(
  platformKey,
  { pins, force = false, resourcesDir = RESOURCES_DIR, download = downloadFile } = {},
) {
  const resolvedPins = pins ?? (await loadPins());
  const pin = resolvedPins.assets[platformKey];
  if (!pin) {
    throw new Error(`No pin for platform "${platformKey}" in ${PINS_PATH}`);
  }

  const targetDir = path.join(resourcesDir, 'sing-box', platformKey);
  const binaryPath = path.join(targetDir, pin.binaryName);

  if (!force) {
    if (await fileMatchesSha256(binaryPath, pin.binarySha256)) {
      console.log(`[prebuild-singbox] ${platformKey}: cached, skipping (${binaryPath})`);
      return binaryPath;
    }
    if (existsSync(binaryPath)) {
      console.warn(`[prebuild-singbox] ${platformKey}: cached binary failed verification, re-fetching`);
      await rm(targetDir, { recursive: true, force: true });
    }
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), 'pf-singbox-dl-'));
  try {
    const archivePath = path.join(scratchDir, path.basename(new URL(pin.url).pathname));
    console.log(`[prebuild-singbox] ${platformKey}: downloading ${pin.url}`);
    await download(pin.url, archivePath);
    await verifySha256(archivePath, pin.sha256);
    console.log(`[prebuild-singbox] ${platformKey}: archive sha256 verified`);

    let extractedPath;
    if (pin.archiveType === 'tar.gz') {
      extractedPath = await extractTarGzBinary(archivePath, targetDir, pin.binaryName);
    } else if (pin.archiveType === 'zip') {
      extractedPath = await extractZipBinary(archivePath, targetDir, pin.binaryName);
    } else {
      throw new Error(`Unknown archiveType "${pin.archiveType}" for platform "${platformKey}"`);
    }

    await verifySha256(extractedPath, pin.binarySha256);
    console.log(`[prebuild-singbox] ${platformKey}: extracted binary sha256 verified`);

    if (process.platform !== 'win32') {
      await chmod(extractedPath, 0o755);
    }

    console.log(`[prebuild-singbox] ${platformKey}: ready at ${extractedPath}`);
    return extractedPath;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Fetches the pinned sing-box source tarball (GPLv3 §6 release attachment)
 * into `<resourcesDir>/sing-box-src/`. Same re-hash-on-cache-hit behaviour
 * as `fetchPlatform`: an existing file is re-verified against the pin on
 * every call, not merely assumed valid because it exists.
 */
export async function fetchSourceTarball({ pins, force = false, resourcesDir = RESOURCES_DIR, download = downloadFile } = {}) {
  const resolvedPins = pins ?? (await loadPins());
  const { sourceTarball } = resolvedPins;
  const sourceDir = path.join(resourcesDir, 'sing-box-src');
  const destPath = path.join(sourceDir, sourceTarball.fileName);

  if (!force) {
    if (await fileMatchesSha256(destPath, sourceTarball.sha256)) {
      console.log(`[prebuild-singbox] source tarball: cached, skipping (${destPath})`);
      return destPath;
    }
    if (existsSync(destPath)) {
      console.warn('[prebuild-singbox] source tarball: cached file failed verification, re-fetching');
      await rm(destPath, { force: true });
    }
  }

  await mkdir(sourceDir, { recursive: true });
  console.log(`[prebuild-singbox] source tarball: downloading ${sourceTarball.url}`);
  await download(sourceTarball.url, destPath);
  await verifySha256(destPath, sourceTarball.sha256);
  console.log(`[prebuild-singbox] source tarball: ready at ${destPath}`);
  return destPath;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const force = args.includes('--force');
  const pins = await loadPins();

  const keys = all ? Object.keys(pins.assets) : [hostPlatformKey()];
  for (const key of keys) {
    await fetchPlatform(key, { pins, force });
  }
  await fetchSourceTarball({ pins, force });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((err) => {
    console.error('[prebuild-singbox] failed:', err.message || err);
    process.exit(1);
  });
}
