/**
 * A stable per-machine device fingerprint for Surfshark's `x-device-id`.
 *
 * The real app derives x-device-id from a hardware fingerprint and caches it, so one machine
 * is one device. proxy-farm does the same in spirit without reproducing the app's exact hash:
 * it derives its OWN fingerprint deterministically from a stable machine id (Windows
 * `MachineGuid`, macOS `IOPlatformUUID`), salted so it can never collide with the app's own
 * device id. The same machine always yields the same fingerprint — proxy-farm is one stable
 * Surfshark device, distinct from the installed app's. When no machine id can be read, the
 * caller falls back to a random fingerprint it then persists (account.meta).
 *
 * Mirrors hma/se-platform/fingerprint.ts; kept separate so the two products never share a salt.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Salt so our fingerprint can never collide with another product's hash of the same id. */
const SALT = 'proxy-farm:surfshark:device:v1';

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

/** A fresh random 64-hex fingerprint, for when no machine id is readable. */
export function randomFingerprint(): string {
  return randomBytes(32).toString('hex');
}

/** The fingerprint to use for a device: a persisted one, else the machine-derived one, else
 * a fresh random one (which the caller must persist so it stays stable). */
export function deviceFingerprint(persisted?: string, deps: MachineIdDeps = {}): string {
  return persisted || machineFingerprint(deps) || randomFingerprint();
}
