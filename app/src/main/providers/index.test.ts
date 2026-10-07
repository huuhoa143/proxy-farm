import { describe, expect, it, beforeEach } from 'vitest';
import { registerAllProviders, getProvider, allProviders } from './index';
import { resetRegistryForTest } from './registry';

describe('registerAllProviders', () => {
  beforeEach(() => {
    resetRegistryForTest();
  });

  it('registers all four built-in providers', () => {
    registerAllProviders();
    expect(allProviders()).toHaveLength(4);
    for (const id of ['hma', 'zoogvpn', 'surfshark', 'file'] as const) {
      expect(getProvider(id)).toBeDefined();
      expect(getProvider(id)!.id).toBe(id);
    }
  });
});
