/**
 * A stable per-machine device fingerprint for se-platform registration.
 *
 * HMA ties a device to the machine (Avast's hardware "MIDEX"), so re-activating on the
 * same machine reuses the same device and never spends an extra license slot. proxy-farm
 * can't reproduce Avast's proprietary MIDEX, but it achieves the same effect by deriving
 * its OWN fingerprint deterministically from a stable machine id (Windows `MachineGuid`,
 * macOS `IOPlatformUUID`): the same machine always yields the same fingerprint, so
 * proxy-farm is one device under the license forever — surviving re-add and reinstall —
 * rather than a throwaway per run. It is NOT HMA's own device (different value), so it uses
 * one of the license's device slots, like installing HMA on another machine would.
 *
 * When no machine id can be read, the caller falls back to a random fingerprint it then
 * persists (account.meta), which stays stable across re-adds via that persistence.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Salt so our fingerprint can never collide with another product's hash of the same id. */
const SALT = 'proxy-farm:hma:se-platform:v1';

export interface MachineIdDeps {
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to the real OS read. */
  readMachineId?: () => string | undefined;
}

/** Read a stable machine id for the current OS, or undefined if none is available. */
export function readMachineId(platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    if (platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
      return m?.[1]?.toLowerCase();
    }
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m?.[1]?.toLowerCase();
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** The deterministic 64-hex fingerprint for this machine, or undefined if no machine id
 * could be read (caller should then generate + persist a random one). */
export function machineFingerprint(deps: MachineIdDeps = {}): string | undefined {
  const id = (deps.readMachineId ?? (() => readMachineId(deps.platform)))();
  if (!id) return undefined;
  return createHash('sha256').update(`${SALT}:${id}`).digest('hex');
}
