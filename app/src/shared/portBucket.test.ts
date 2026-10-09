import { describe, expect, it } from 'vitest';
import type { PortState } from './contracts';
import { portBucket } from './portBucket';

const online: PortState = { kind: 'online', since: 1, exitIp: '1.2.3.4', country: 'JP', latencyMs: 40 };

describe('portBucket', () => {
  it('online is alive, unless its latest check failed', () => {
    expect(portBucket(online)).toBe('alive');
    expect(portBucket(online, { ok: true, latencyMs: 30 })).toBe('alive');
    expect(portBucket(online, { ok: false })).toBe('dead');
  });

  it('failed and retrying are dead, whatever a check said', () => {
    expect(portBucket({ kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 })).toBe('dead');
    expect(portBucket({ kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'x' }, { ok: true })).toBe('dead');
  });

  it('queued, connecting and verifying are connecting', () => {
    expect(portBucket({ kind: 'queued' })).toBe('connecting');
    expect(portBucket({ kind: 'connecting', since: 1 })).toBe('connecting');
    expect(portBucket({ kind: 'verifying', since: 1 })).toBe('connecting');
  });

  it('stopped is stopped', () => {
    expect(portBucket({ kind: 'stopped' })).toBe('stopped');
  });
});
