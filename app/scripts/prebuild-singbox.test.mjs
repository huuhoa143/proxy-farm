import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { verifySha256, fetchPlatform, fetchSourceTarball } from './prebuild-singbox.mjs';

// Fixture content and its sha256, computed independently with
// `printf 'hello sing-box\n' | shasum -a 256` — not derived from the code
// under test, so this is a real check rather than a tautology.
const FIXTURE_CONTENT = 'hello sing-box\n';
const FIXTURE_SHA256 = '3c8bb859287275730ddceb333305c3aad3e73595a632c6ac952aec3acf34ee0a';
const WRONG_SHA256 = '0000000000000000000000000000000000000000000000000000000000000';

describe('verifySha256', () => {
  let dir;
  let fixturePath;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-singbox-test-'));
    fixturePath = join(dir, 'fixture.txt');
    writeFileSync(fixturePath, FIXTURE_CONTENT);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves true when the file matches the expected hash', async () => {
    await expect(verifySha256(fixturePath, FIXTURE_SHA256)).resolves.toBe(true);
  });

  it('is case-insensitive about hex casing', async () => {
    await expect(verifySha256(fixturePath, FIXTURE_SHA256.toUpperCase())).resolves.toBe(true);
  });

  it('throws when the file does not match the expected hash', async () => {
    await expect(verifySha256(fixturePath, WRONG_SHA256)).rejects.toThrow(/sha256 mismatch/i);
  });
});

async function sha256File(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

describe('fetchPlatform cache behaviour', () => {
  let workDir;
  let fixtureArchivePath;
  let binaryContent;
  let pins;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'pf-singbox-fetch-test-'));

    // A tiny but *real* tar.gz, shaped like the actual release assets: a
    // top-level `sing-box-<ver>-<platform>/` dir containing the binary, so
    // the real extractTarGzBinary (strip:1 + filter) code path is exercised.
    const srcDir = join(workDir, 'fixture-src');
    const topDir = join(srcDir, 'sing-box-test-fixture');
    mkdirSync(topDir, { recursive: true });
    binaryContent = 'FAKE-SING-BOX-BINARY\n';
    writeFileSync(join(topDir, 'sing-box'), binaryContent);
    fixtureArchivePath = join(workDir, 'fixture.tar.gz');
    await tar.c({ gzip: true, file: fixtureArchivePath, cwd: srcDir }, ['sing-box-test-fixture']);

    const binarySha256 = createHash('sha256').update(binaryContent).digest('hex');
    const archiveSha256 = await sha256File(fixtureArchivePath);

    pins = {
      assets: {
        'test-platform': {
          url: 'https://example.invalid/fixture.tar.gz',
          sha256: archiveSha256,
          archiveType: 'tar.gz',
          binaryName: 'sing-box',
          binarySha256,
        },
      },
    };
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('(b) treats a cached binary matching binarySha256 as cached — no download', async () => {
    const resourcesDir = mkdtempSync(join(workDir, 'res-match-'));
    const targetDir = join(resourcesDir, 'sing-box', 'test-platform');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'sing-box'), binaryContent);

    const download = vi.fn(async () => {
      throw new Error('download should not have been called for a valid cache hit');
    });

    const result = await fetchPlatform('test-platform', { pins, resourcesDir, download });

    expect(download).not.toHaveBeenCalled();
    expect(result).toBe(join(targetDir, 'sing-box'));
    expect(readFileSync(result, 'utf8')).toBe(binaryContent);
  });

  it('(a) does NOT trust a cached binary whose bytes do not match binarySha256 — re-fetches', async () => {
    const resourcesDir = mkdtempSync(join(workDir, 'res-mismatch-'));
    const targetDir = join(resourcesDir, 'sing-box', 'test-platform');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'sing-box'), 'TAMPERED-OR-CORRUPTED-BYTES\n');

    const download = vi.fn(async (_url, destPath) => {
      await writeFile(destPath, await readFile(fixtureArchivePath));
    });

    const result = await fetchPlatform('test-platform', { pins, resourcesDir, download });

    expect(download).toHaveBeenCalledTimes(1);
    expect(readFileSync(result, 'utf8')).toBe(binaryContent);
  });

  it('re-fetches unconditionally when force is set, even with a valid cache', async () => {
    const resourcesDir = mkdtempSync(join(workDir, 'res-force-'));
    const targetDir = join(resourcesDir, 'sing-box', 'test-platform');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'sing-box'), binaryContent);

    const download = vi.fn(async (_url, destPath) => {
      await writeFile(destPath, await readFile(fixtureArchivePath));
    });

    await fetchPlatform('test-platform', { pins, resourcesDir, download, force: true });

    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe('fetchSourceTarball cache behaviour', () => {
  let workDir;
  let pins;
  const sourceContent = 'FAKE-SOURCE-TARBALL-CONTENT\n';

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pf-singbox-src-test-'));
    const sourceSha256 = createHash('sha256').update(sourceContent).digest('hex');
    pins = {
      sourceTarball: {
        url: 'https://example.invalid/source.tar.gz',
        sha256: sourceSha256,
        fileName: 'source-fixture.tar.gz',
      },
    };
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('(c) treats a cached file matching the pin as cached — no download', async () => {
    const resourcesDir = mkdtempSync(join(workDir, 'res-match-'));
    const sourceDir = join(resourcesDir, 'sing-box-src');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, pins.sourceTarball.fileName), sourceContent);

    const download = vi.fn(async () => {
      throw new Error('download should not have been called for a valid cache hit');
    });

    const result = await fetchSourceTarball({ pins, resourcesDir, download });

    expect(download).not.toHaveBeenCalled();
    expect(readFileSync(result, 'utf8')).toBe(sourceContent);
  });

  it('(c) re-verifies on cache-hit and re-fetches when the cached file does not match the pin', async () => {
    const resourcesDir = mkdtempSync(join(workDir, 'res-mismatch-'));
    const sourceDir = join(resourcesDir, 'sing-box-src');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, pins.sourceTarball.fileName), 'TAMPERED-OR-CORRUPTED-BYTES\n');

    const download = vi.fn(async (_url, destPath) => {
      await writeFile(destPath, sourceContent);
    });

    const result = await fetchSourceTarball({ pins, resourcesDir, download });

    expect(download).toHaveBeenCalledTimes(1);
    expect(readFileSync(result, 'utf8')).toBe(sourceContent);
  });
});
