/**
 * The remaining thin bindings from the real engine/health modules (merged from
 * `v2/engine`) to this worktree's own `PortAllocator`/`ExitIpProber` ports — the
 * counterparts to `engine-adapter.ts`'s `Engine` binding. Kept separate since these are
 * one-liners with no state of their own, unlike the per-port lifecycle `Engine` needs.
 */
import { allocatePort, isPortFree } from '../engine/ports';
import { probeExitIp } from '../health/exit-ip';
import type { ExitIpProber, PortAllocator } from './ports';

const DEFAULT_AUX_BASE = 40000;

export function createRealPortAllocator(): PortAllocator {
  return {
    allocate: (opts) => allocatePort(opts),
    allocateAux: (opts) => allocatePort({ base: DEFAULT_AUX_BASE, taken: opts?.taken }),
    release: () => undefined, // nothing to release: freedom is just "not in `taken` next time"
  };
}

export function createRealExitIpProber(): ExitIpProber {
  return {
    probe: (proxyPort, auth) => probeExitIp(proxyPort, { auth }),
  };
}

export { isPortFree };
