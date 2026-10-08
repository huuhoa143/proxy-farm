import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSurfsharkProvider, parseIpv4Cidr, parseSurfsharkConf } from './index';
import type { Account, AccountSecret } from '../types';
import type { SurfsharkCluster } from './clusters';
import type { PoolNet } from './pool';

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

let cacheDir: string;
let cachePath: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'pf-surfshark-index-'));
  cachePath = path.join(cacheDir, 'clusters.json');
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Writes the on-disk cache file directly — simulates a prior fetch, possibly by another process/instance. */
function writeCacheFile(clusters: SurfsharkCluster[], fetchedAt = 1_000_000) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ fetchedAt, clusters }), 'utf8');
}

/** Hermetic DNS: every lookup of the cluster answers with the given IPs. */
function fakePoolNet(answers: string[][] = [['192.0.2.10', '192.0.2.11']]): PoolNet {
  let i = 0;
  return {
    resolveSystem: async () => answers[Math.min(i++, answers.length - 1)],
    resolveDoh: async () => [],
    sleep: async () => {},
  };
}

function makeProvider(poolNet: PoolNet = fakePoolNet()) {
  return createSurfsharkProvider({ cachePath, loadClusters: async () => fakeClusters(), poolNet });
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

/** Shaped like the config Surfshark's dashboard downloads for a key (dummy values). */
const DOWNLOADED_CONF = `[Interface]
PrivateKey = ${DUMMY_PRIVATE_KEY}
Address = 10.64.12.34/16, fd00:1234::2/128
DNS = 162.252.172.57, 149.154.159.92

[Peer]
PublicKey = l8EOWPyzt/njrb74CADY4VOhns/TbUN6KFTbytHcFQw=
AllowedIPs = 0.0.0.0/0
Endpoint = jp-tok.prod.surfshark.com:51820
`;

describe('surfshark provider: per-key interface address', () => {
  it('defaults the address to 10.14.0.2/16 when none is given', () => {
    expect(makeProvider().check({ privateKey: DUMMY_PRIVATE_KEY }).meta).toEqual({ address: '10.14.0.2/16' });
  });

  it('takes a typed address, normalised, and rejects one that is not an IPv4 CIDR', () => {
    const provider = makeProvider();
    expect(provider.check({ privateKey: DUMMY_PRIVATE_KEY, address: ' 10.64.7.9/16 ' }).meta).toEqual({ address: '10.64.7.9/16' });
    for (const bad of ['10.64.7.9', '10.64.7.300/16', '10.64.7.9/33', 'fd00::2/128', 'nope']) {
      expect(provider.check({ privateKey: DUMMY_PRIVATE_KEY, address: bad })).toEqual({ ok: false, reasonKey: 'surfshark.check.invalidAddress' });
    }
  });

  it('extracts PrivateKey and the first IPv4 Address from a pasted or imported .conf, ignoring the rest', () => {
    const provider = makeProvider();
    const inputs: Array<Record<string, string>> = [{ privateKey: DOWNLOADED_CONF }, { config: DOWNLOADED_CONF }, { config: DOWNLOADED_CONF, address: '10.14.0.2/16' }];
    for (const input of inputs) {
      const result = provider.check(input);
      expect(result.ok).toBe(true);
      expect(result.secret).toEqual({ kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY });
      expect(result.meta).toEqual({ address: '10.64.12.34/16' });
    }
  });

  it('a .conf without a PrivateKey is rejected; one without an Address falls back to the field/default', () => {
    const provider = makeProvider();
    expect(provider.check({ config: '[Interface]\nAddress = 10.64.1.2/16\n' })).toEqual({ ok: false, reasonKey: 'surfshark.check.invalidConfig' });
    const noAddress = `[Interface]\nPrivateKey = ${DUMMY_PRIVATE_KEY}\n`;
    expect(provider.check({ config: noAddress }).meta).toEqual({ address: '10.14.0.2/16' });
    expect(provider.check({ config: noAddress, address: '10.64.3.4/16' }).meta).toEqual({ address: '10.64.3.4/16' });
  });

  it('parseSurfsharkConf: only [Interface] counts, comments are ignored, a bare address is /32', () => {
    expect(parseSurfsharkConf('[Peer]\nAddress = 10.1.1.1/16\n[Interface]\n# Address = 9.9.9.9/8\nAddress = 10.64.0.5\n')).toEqual({ address: '10.64.0.5/32' });
    expect(parseIpv4Cidr('010.14.0.2/16')).toBe('10.14.0.2/16');
  });

  it('bind() uses the account address, and the old default for an account that has none', () => {
    writeCacheFile(fakeClusters());
    const provider = createSurfsharkProvider({ cachePath });
    const secret: AccountSecret = { kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY };
    const target = { key: 'surfshark:jp-tok', providerId: 'surfshark' as const, country: 'JP', city: 'Tokyo', label: '', servers: [] };
    const acc = (meta: Record<string, string>): Account => ({ id: 'ss-1', providerId: 'surfshark', label: 'S', meta, secretRef: 'ss-1' });
    const addr = (meta: Record<string, string>) => {
      const ep = provider.bind(target, '203.0.113.50', acc(meta), secret);
      return ep.type === 'wireguard' ? ep.address : undefined;
    };
    expect(addr({ address: '10.64.12.34/16' })).toEqual(['10.64.12.34/16']);
    expect(addr({})).toEqual(['10.14.0.2/16']);
    expect(addr({ address: 'garbage' })).toEqual(['10.14.0.2/16']);
  });
});

describe('surfshark provider: targets', () => {
  const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };

  it("targets() reflects the cluster list, with the cluster's discovered pool IPs as servers", async () => {
    const provider = makeProvider();
    const targets = await provider.targets(account);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: 'surfshark:jp-tok',
      providerId: 'surfshark',
      country: 'JP',
      servers: ['192.0.2.10', '192.0.2.11'],
    });
  });

  it('falls back to the cluster hostname while discovery has found nothing', async () => {
    const provider = makeProvider({
      resolveSystem: async () => {
        throw new Error('offline');
      },
      resolveDoh: async () => {
        throw new Error('offline');
      },
      sleep: async () => {},
    });
    const [target] = await provider.targets(account);
    expect(target.servers).toEqual(['jp-tok.prod.surfshark.com']);
    // The hostname is a round-robin pool: one port pinned to it does not use it up.
    expect(target.poolHostnames).toBe(true);
  });

  it('persists the pool beside the cluster cache, so a new instance starts with it', async () => {
    await makeProvider().targets(account);
    await vi.waitFor(() => expect(existsSync(path.join(cacheDir, 'surfshark-pools.json'))).toBe(true));

    const offline: PoolNet = { resolveSystem: async () => [], resolveDoh: async () => [], sleep: async () => {} };
    const [target] = await makeProvider(offline).targets(account);
    expect(target.servers).toEqual(['192.0.2.10', '192.0.2.11']);
  });
});

describe('surfshark provider: bind (deterministic, reads the on-disk cache directly)', () => {
  it('a FRESH provider instance — no targets() call ever made on it — binds successfully from an existing cache file', () => {
    // Simulates a persisted port rebound after an app restart: a new
    // provider instance, cache file already on disk from a previous run.
    writeCacheFile(fakeClusters());
    const provider = createSurfsharkProvider({ cachePath }); // no loadClusters injected either
    const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };
    const secret: AccountSecret = { kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY };
    const target = {
      key: 'surfshark:jp-tok',
      providerId: 'surfshark' as const,
      country: 'JP',
      city: 'Tokyo',
      label: 'Japan — Tokyo',
      servers: ['jp-tok.prod.surfshark.com'],
    };

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
    const json = JSON.stringify(endpoint);
    expect(json).not.toMatch(/_path/);
  });

  it('throws a clear error when the cache file does not exist at all', () => {
    const provider = createSurfsharkProvider({ cachePath }); // cachePath never written to
    const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };
    const secret: AccountSecret = { kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY };
    const target = { key: 'surfshark:jp-tok', providerId: 'surfshark' as const, country: 'JP', city: '', label: '', servers: ['nope'] };
    expect(() => provider.bind(target, '1.2.3.4', account, secret)).toThrow(/no cached cluster/);
  });

  it('throws a clear error when the cache exists but has no matching location', () => {
    writeCacheFile(fakeClusters()); // only has jp-tok
    const provider = createSurfsharkProvider({ cachePath });
    const account: Account = { id: 'ss-1', providerId: 'surfshark', label: 'Surfshark', meta: {}, secretRef: 'ss-1' };
    const secret: AccountSecret = { kind: 'wgkey', privateKey: DUMMY_PRIVATE_KEY };
    const unknownTarget = {
      key: 'surfshark:unknown',
      providerId: 'surfshark' as const,
      country: 'XX',
      city: '',
      label: '',
      servers: ['nope'],
    };
    expect(() => provider.bind(unknownTarget, '1.2.3.4', account, secret)).toThrow(/no cached cluster/);
  });
});
