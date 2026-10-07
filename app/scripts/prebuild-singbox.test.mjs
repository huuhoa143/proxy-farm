import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySha256 } from './prebuild-singbox.mjs';

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
