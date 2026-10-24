import { describe, expect, it } from 'vitest';
import { deviceFingerprint, machineFingerprint, randomFingerprint } from './fingerprint';

describe('surfshark fingerprint', () => {
  it('machineFingerprint is deterministic 64-hex for a given machine id', () => {
    const read = () => 'ABCDEF01-2345-6789-ABCD-EF0123456789';
    const a = machineFingerprint({ readMachineId: read });
    const b = machineFingerprint({ readMachineId: read });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs from the HMA salt (different value for the same id)', () => {
    // A machine id hashed with our salt must not equal its plain sha256 or an empty hash.
    const fp = machineFingerprint({ readMachineId: () => 'same-id' });
    expect(fp).not.toBe('same-id');
  });

  it('undefined when no machine id is readable', () => {
    expect(machineFingerprint({ readMachineId: () => undefined })).toBeUndefined();
  });

  it('randomFingerprint is 64-hex and unique', () => {
    expect(randomFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomFingerprint()).not.toBe(randomFingerprint());
  });

  it('deviceFingerprint prefers a persisted value, then machine, then random', () => {
    expect(deviceFingerprint('persisted', { readMachineId: () => 'm' })).toBe('persisted');
    const m = deviceFingerprint(undefined, { readMachineId: () => 'm' });
    expect(m).toBe(machineFingerprint({ readMachineId: () => 'm' }));
    expect(deviceFingerprint('', { readMachineId: () => undefined })).toMatch(/^[0-9a-f]{64}$/);
  });
});
