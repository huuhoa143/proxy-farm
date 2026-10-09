import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-write';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-atomic-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('creates missing folders, writes, and replaces an existing file without leaving temp files', async () => {
    const file = join(dir, 'a', 'b', 'cache.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['cache.json']);
  });

  it('concurrent writers never share a temp file; the last rename wins whole', async () => {
    const file = join(dir, 'cache.json');
    await Promise.all(['x'.repeat(50_000), 'y'.repeat(50_000), 'z'.repeat(50_000)].map((d) => writeFileAtomic(file, d)));
    expect(readFileSync(file, 'utf8')).toMatch(/^(x{50000}|y{50000}|z{50000})$/);
    expect(readdirSync(dir)).toEqual(['cache.json']);
  });

  it('rejects when the rename cannot succeed, and removes its temp file', async () => {
    const file = join(dir, 'taken');
    mkdirSync(join(file, 'inside'), { recursive: true }); // a non-empty folder in the way
    await expect(writeFileAtomic(file, 'data', { backoffMs: 1 })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['taken']);
  });
});
