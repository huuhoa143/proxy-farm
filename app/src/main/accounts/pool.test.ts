import { describe, expect, it } from 'vitest';
import type { Account, PortRow } from '../../shared/contracts';
import { createAccountPool, type AccountPoolDeps } from './pool';
import { createRefusalTracker } from './refusals';

function acct(id: string, providerId: Account['providerId'] = 'zoogvpn'): Account {
  return { id, providerId, label: id, meta: {}, secretRef: `acct:${id}` };
}

function port(key: string, accountId: string, enabled = true, providerId: PortRow['providerId'] = 'zoogvpn'): PortRow {
  return {
    key,
    providerId,
    accountId,
    label: key,
    country: 'NL',
    city: 'Amsterdam',
    proxyPort: 29001,
    enabled,
    state: { kind: 'stopped' },
    autoRotateMin: 0,
  };
}

/** An in-memory fake of AccountPoolDeps backed by plain arrays, mutable like real state. */
function fakeDeps(opts: { accounts?: Account[]; ports?: PortRow[]; limits?: Partial<Record<string, number>>; broken?: Set<string> } = {}) {
  const accounts = opts.accounts ?? [];
  const ports = opts.ports ?? [];
  const limits = opts.limits ?? {};
  const broken = opts.broken ?? new Set<string>();
  const refusals = createRefusalTracker();
  const deps: AccountPoolDeps = {
    listAccounts: () => accounts,
    listPorts: () => ports,
    setPortAccount: (key, accountId) => {
      const p = ports.find((x) => x.key === key);
      if (p) p.accountId = accountId;
    },
    getLimit: (providerId) => limits[providerId] ?? 0,
    isUsable: (id) => !broken.has(id),
    refusals,
  };
  return { deps, accounts, ports, limits, broken, refusals };
}

describe('account pool (spec §4.2)', () => {
  it('picks the emptiest usable account; a stopped port holds no load', () => {
    const { deps, ports } = fakeDeps({
      accounts: [acct('z1'), acct('z2'), acct('z3')],
      ports: [port('a', 'z1'), port('b', 'z1'), port('c', 'z2'), port('d', 'z3', false)],
    });
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn')?.id).toBe('z3'); // z3's only port is disabled
    ports.push(port('e', 'z3'));
    expect(pool.pickAccount('zoogvpn')?.id).toBe('z2'); // z2:1 z3:1, z2 comes first
  });

  it('prefer wins ties so a restart keeps its account', () => {
    const { deps } = fakeDeps({
      accounts: [acct('z1'), acct('z2')],
      ports: [port('a', 'z1'), port('b', 'z2')],
    });
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn', { prefer: 'z2' })?.id).toBe('z2');
  });

  it('pinned honours prefer regardless of load', () => {
    const { deps } = fakeDeps({
      accounts: [acct('z1'), acct('z2')],
      ports: [port('a', 'z1'), port('b', 'z1')],
    });
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn', { prefer: 'z1' })?.id).toBe('z2');
    expect(pool.pickAccount('zoogvpn', { prefer: 'z1', pinned: true })?.id).toBe('z1');
  });

  it('excludes a refused (account, server) pair', () => {
    const { deps, refusals } = fakeDeps({
      accounts: [acct('z1'), acct('z2')],
      ports: [],
    });
    refusals.recordAuthFailure('z1', 'zoogvpn:nl');
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn', { key: 'zoogvpn:nl' })?.id).toBe('z2');
  });

  it('excludes a broken (unusable) account', () => {
    const { deps } = fakeDeps({
      accounts: [acct('z1'), acct('z2')],
      ports: [],
      broken: new Set(['z1']),
    });
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn')?.id).toBe('z2');
  });

  it('returns undefined when every account is excluded, broken, refused, or at its limit', () => {
    const { deps } = fakeDeps({
      accounts: [acct('z1')],
      ports: [],
      broken: new Set(['z1']),
    });
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn')).toBeUndefined();
  });

  it('enforces the per-provider limit (0 = unlimited)', () => {
    const { deps } = fakeDeps({
      accounts: [acct('z1')],
      ports: [port('a', 'z1')],
      limits: { zoogvpn: 1 },
    });
    const pool = createAccountPool(deps);
    expect(pool.pickAccount('zoogvpn')).toBeUndefined();
    expect(pool.atLimit('zoogvpn')).toBe(true);
  });

  it('ports of other providers do not affect this provider pick or load', () => {
    const { deps } = fakeDeps({
      accounts: [acct('z1', 'zoogvpn'), acct('h1', 'hma')],
      ports: [port('a', 'h1', true, 'hma')],
    });
    const pool = createAccountPool(deps);
    expect(pool.load('zoogvpn')).toEqual({});
    expect(pool.pickAccount('zoogvpn')?.id).toBe('z1');
  });

  describe('rebalance', () => {
    it('moves ports off a deleted/excluded account onto others with room', () => {
      const { deps, ports } = fakeDeps({
        accounts: [acct('z2')], // z1 is gone from the account list
        ports: [port('a', 'z1'), port('b', 'z1')],
      });
      const pool = createAccountPool(deps);
      const moved = pool.rebalance('zoogvpn');
      expect(moved.sort()).toEqual(['a', 'b']);
      expect(ports.find((p) => p.key === 'a')?.accountId).toBe('z2');
      expect(ports.find((p) => p.key === 'b')?.accountId).toBe('z2');
    });

    it('leaves a port alone when its current account is still the best pick', () => {
      const { deps } = fakeDeps({
        accounts: [acct('z1')],
        ports: [port('a', 'z1')],
      });
      const pool = createAccountPool(deps);
      expect(pool.rebalance('zoogvpn')).toEqual([]);
    });
  });

  describe('moveOnRefusal', () => {
    it('moves a refused port to a different account', () => {
      const { deps, refusals } = fakeDeps({
        accounts: [acct('z1'), acct('z2')],
        ports: [port('a', 'z1')],
      });
      refusals.recordAuthFailure('z1', 'a');
      const pool = createAccountPool(deps);
      const next = pool.moveOnRefusal('a');
      expect(next?.id).toBe('z2');
    });

    it('returns undefined when no other account is free', () => {
      const { deps, refusals } = fakeDeps({
        accounts: [acct('z1')],
        ports: [port('a', 'z1')],
      });
      refusals.recordAuthFailure('z1', 'a');
      const pool = createAccountPool(deps);
      expect(pool.moveOnRefusal('a')).toBeUndefined();
    });

    it('returns undefined for an unknown port key', () => {
      const { deps } = fakeDeps({ accounts: [acct('z1')], ports: [] });
      const pool = createAccountPool(deps);
      expect(pool.moveOnRefusal('nope')).toBeUndefined();
    });
  });
});
