import { describe, expect, it } from 'vitest';
import { createSurfsharkProvider } from './index';
import type { Account, AccountSecret } from '../types';
import type { SurfsharkCluster } from './clusters';

// A syntactically valid-looking WireGuard key shape (32 random bytes,
// base64), NOT a real key used by any account.
const DUMMY_PRIVATE_KEY = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';

function fakeClusters(): SurfsharkCluster[] {
  return [
    {
      type: 'generic',
      countryCode: 'JP',
      country: 'Japan',
      location: 'Tokyo',
      connectionName: 'jp-tok.prod.surfshark.com',
      pubKey: 'l8EOWPyzt/njrb74CADY4VOhns/TbUN6KFTbytHcFQw=',
    },
  ];
}

function makeProvider() {
  return createSurfsharkProvider({ loadClusters: async () => fakeClusters() });
}

describe('surfshark provider: check', () => {
  it('accepts a 44-char base64 (32-byte) WireGuard private key', () => {
    const provider = makeProvider();
    const result = provider.check({ privateKey: DUMMY_PRIVATE_KEY });
    expect(result.ok).toBe(true);
    expect(result.secret).toEqual({ kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY });
  });

  it('rejects a key of the wrong length', () => {
    const provider = makeProvider();
    expect(provider.check({ privateKey: 'tooShort=' }).ok).toBe(false);
  });

  it('rejects a key with invalid base64 characters', () => {
    const provider = makeProvider();
    expect(provider.check({ privateKey: '!!!!5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=' }).ok).toBe(false);
  });
});

describe('surfshark provider: targets + bind', () => {
  it('targets() reflects the cached cluster list', async () => {
    const provider = makeProvider();
    const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };
    const targets = await provider.targets(account);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      providerId: 'surfshark',
      country: 'JP',
      servers: ['jp-tok.prod.surfshark.com'],
    });
  });

  it('bind() builds a WireguardEndpoint using the peer pubKey resolved via targets()', async () => {
    const provider = makeProvider();
    const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };
    const targets = await provider.targets(account);
    const target = targets[0];
    const secret: AccountSecret = { kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY };

    const endpoint = provider.bind(target, '203.0.113.50', account, secret);

    expect(endpoint.type).toBe('wireguard');
    if (endpoint.type !== 'wireguard') throw new Error('unreachable');
    expect(endpoint.address).toEqual(['10.14.0.2/16']);
    expect(endpoint.private_key).toBe(DUMMY_PRIVATE_KEY);
    expect(endpoint.mtu).toBe(1280);
    expect(endpoint.peers).toHaveLength(1);
    expect(endpoint.peers[0]).toEqual({
      address: '203.0.113.50',
      port: 51820,
      public_key: 'l8EOWPyzt/njrb74CADY4VOhns/TbUN6KFTbytHcFQw=',
      allowed_ips: ['0.0.0.0/0'],
      persistent_keepalive_interval: 25,
    });
  });

  it('bind() throws a clear error for a target whose cluster was never loaded', () => {
    const provider = makeProvider();
    const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };
    const secret: AccountSecret = { kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY };
    const unknownTarget = { key: 'surfshark:unknown', providerId: 'surfshark' as const, country: 'XX', city: '', label: '', servers: ['nope'] };
    expect(() => provider.bind(unknownTarget, '1.2.3.4', account, secret)).toThrow(/unknown target/);
  });
});
