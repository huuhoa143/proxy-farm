import { describe, expect, it, beforeEach } from 'vitest';
import { registerProvider, getProvider, allProviders, resetRegistryForTest } from './registry';
import type { Provider } from './types';

function fakeProvider(id: Provider['id']): Provider {
  return {
    id,
    check: () => ({ ok: true }),
    targets: async () => [],
    bind: () => {
      throw new Error('not used in this test');
    },
  };
}

describe('provider registry', () => {
  beforeEach(() => {
    resetRegistryForTest();
  });

  it('returns undefined for an id nothing registered yet', () => {
    expect(getProvider('hma')).toBeUndefined();
  });

  it('registers a provider and retrieves it by id', () => {
    const p = fakeProvider('hma');
    registerProvider(p);
    expect(getProvider('hma')).toBe(p);
  });

  it('lists all registered providers', () => {
    const hma = fakeProvider('hma');
    const zoog = fakeProvider('zoogvpn');
    registerProvider(hma);
    registerProvider(zoog);
    expect(allProviders()).toEqual(expect.arrayContaining([hma, zoog]));
    expect(allProviders()).toHaveLength(2);
  });

  it('registering the same id twice replaces the previous registration', () => {
    const first = fakeProvider('surfshark');
    const second = fakeProvider('surfshark');
    registerProvider(first);
    registerProvider(second);
    expect(getProvider('surfshark')).toBe(second);
    expect(allProviders()).toHaveLength(1);
  });
});
