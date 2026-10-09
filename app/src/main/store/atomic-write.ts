import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Windows: antivirus, the search indexer or a reader holding the target can make a rename
 * fail for a moment; these codes are worth another try, anything else is not. */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Writes `data` to `file` via a temp file + rename, so a crash never leaves half a file and
 * a reader sees the old or the new content. The temp name is unique per write, so
 * concurrent writers never share one, and a rename that Windows refuses for a moment is
 * retried with a short backoff. The temp file is removed when the write fails.
 */
export async function writeFileAtomic(file: string, data: string, opts: { retries?: number; backoffMs?: number } = {}): Promise<void> {
  const retries = opts.retries ?? 5;
  const backoffMs = opts.backoffMs ?? 40;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, data, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (attempt >= retries || !TRANSIENT_RENAME.has(code)) throw err;
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
