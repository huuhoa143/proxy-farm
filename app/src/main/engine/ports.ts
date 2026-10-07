import net from 'node:net';

const DEFAULT_BASE = 10000;
const MAX_SCAN_ATTEMPTS = 2000;

/** Resolves true iff a bare TCP listener can bind `host:port`, closing it immediately after. */
function tryBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * A port is free only if a bind succeeds on BOTH `127.0.0.1` and `0.0.0.0`
 * (spec §6.2): a foreign listener bound only to the wildcard address would
 * otherwise let a `127.0.0.1` bind succeed silently, masking a real conflict.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const loopbackFree = await tryBind('127.0.0.1', port);
  if (!loopbackFree) return false;
  const wildcardFree = await tryBind('0.0.0.0', port);
  return wildcardFree;
}

export interface AllocatePortOptions {
  /** Try this port first. */
  preferred?: number;
  /** Ports to treat as occupied even if nothing is actually listening (e.g. ports already assigned to other rows). */
  taken?: Set<number>;
  /** Where to start scanning if `preferred` is unavailable (or absent). @default 10000 */
  base?: number;
}

/**
 * Picks a free, untaken port: `preferred` if it is both free and untaken,
 * otherwise the first free, untaken port scanning upward from `base`.
 */
export async function allocatePort(opts: AllocatePortOptions = {}): Promise<number> {
  const taken = opts.taken ?? new Set<number>();

  if (opts.preferred !== undefined && !taken.has(opts.preferred) && (await isPortFree(opts.preferred))) {
    return opts.preferred;
  }

  let candidate = opts.base ?? DEFAULT_BASE;
  for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1, candidate += 1) {
    if (taken.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(`allocatePort: no free port found after scanning ${MAX_SCAN_ATTEMPTS} ports from ${opts.base ?? DEFAULT_BASE}`);
}
