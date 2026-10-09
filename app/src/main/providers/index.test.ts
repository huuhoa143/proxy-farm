import { describe, expect, it, beforeEach } from 'vitest';
import { registerAllProviders, getProvider, allProviders } from './index';
import { resetRegistryForTest } from './registry';

describe('registerAllProviders', () => {
  beforeEach(() => {
    resetRegistryForTest();
  });

  it('registers all five built-in providers', () => {
    registerAllProviders({ surfsharkCachePath: '/tmp/pf-v2-test-unused/surfshark-clusters.json' });
    expect(allProviders()).toHaveLength(5);
    for (const id of ['hma', 'zoogvpn', 'surfshark', 'nordvpn', 'file'] as const) {
      expect(getProvider(id)).toBeDefined();
      expect(getProvider(id)!.id).toBe(id);
    }
  });
});
