import type { Account, PortRow, ProviderId } from '../../shared/contracts';
import type { RefusalTracker } from './refusals';

export interface PickAccountOptions {
  /** Target/server key the port is for; accounts refused for it are skipped. */
  key?: string;
  /** Preferred account id (usually the port's current one): wins ties. */
  prefer?: string;
  /** Honour `prefer` regardless of load, as long as it is still usable (a pin). */
  pinned?: boolean;
  /** Never return this account id (e.g. one just refused, or being deleted). */
  exclude?: string;
  /** A port key whose current assignment should not count against the load (it is
   * about to be rebound, so its existing session should not block itself). */
  forPortKey?: string;
}

export interface AccountPoolDeps {
  /** All known accounts (every provider); pool.ts filters by providerId itself. */
  listAccounts(): Account[];
  /** All known ports (every provider); pool.ts filters by providerId itself. */
  listPorts(): PortRow[];
  /** Reassign a port to a different account. */
  setPortAccount(key: string, accountId: string): void;
  /** Per-provider port limit; 0 = unlimited (spec §4.2 `setLimit`). */
  getLimit(providerId: ProviderId): number;
  /** An account the provider marked broken (e.g. auth) is skipped entirely. */
  isUsable(accountId: string): boolean;
  refusals: Pick<RefusalTracker, 'isRefused'>;
}

export interface AccountPool {
  /** The emptiest usable account of this provider with room to spare; `undefined` if none. */
  pickAccount(providerId: ProviderId, opts?: PickAccountOptions): Account | undefined;
  /** Ports of this provider currently assigned to each account (enabled ports only). */
  load(providerId: ProviderId, exceptPortKey?: string): Record<string, number>;
  /** Reassign every enabled port of this provider to the best available account.
   * Returns the keys of ports that were actually moved. */
  rebalance(providerId: ProviderId): string[];
  /** The target was refused by its current account: move it to another one that can
   * take it. Returns the new account, or undefined if none was free. */
  moveOnRefusal(targetKey: string): Account | undefined;
  /** True when one more enabled port of this provider would exceed its limit. */
  atLimit(providerId: ProviderId): boolean;
}

export function createAccountPool(deps: AccountPoolDeps): AccountPool {
  function accountsOf(providerId: ProviderId): Account[] {
    return deps.listAccounts().filter((a) => a.providerId === providerId);
  }

  function load(providerId: ProviderId, exceptPortKey?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of deps.listPorts()) {
      if (p.providerId !== providerId || !p.enabled || p.key === exceptPortKey) continue;
      out[p.accountId] = (out[p.accountId] ?? 0) + 1;
    }
    return out;
  }

  function pickAccount(providerId: ProviderId, opts: PickAccountOptions = {}): Account | undefined {
    const list = accountsOf(providerId);
    const ok = (a: Account): boolean =>
      a.id !== opts.exclude && deps.isUsable(a.id) && !(opts.key && deps.refusals.isRefused(a.id, opts.key));

    if (opts.pinned && opts.prefer) {
      const pinned = list.find((a) => a.id === opts.prefer);
      if (pinned && ok(pinned)) return pinned;
    }

    const loadMap = load(providerId, opts.forPortKey);
    const limit = deps.getLimit(providerId);
    const order = new Map(list.map((a, i) => [a.id, i]));

    // `setLimit`'s one consistent meaning (spec §4.2) is the provider's TOTAL running
    // ports, the same thing `atLimit` checks — not a per-account cap. So once that total
    // is reached, no account of this provider can take one more port at all; below it,
    // every usable/non-refused account is still a candidate, picked by least-loaded.
    const totalUsed = Object.values(loadMap).reduce((sum, n) => sum + n, 0);
    const providerHasRoom = limit === 0 || totalUsed < limit;

    const free = providerHasRoom
      ? list.filter(ok).sort((a, b) => {
          const used = (loadMap[a.id] ?? 0) - (loadMap[b.id] ?? 0);
          if (used) return used;
          const pa = a.id === opts.prefer ? 0 : 1;
          const pb = b.id === opts.prefer ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
        })
      : [];

    return free[0];
  }

  function rebalance(providerId: ProviderId): string[] {
    const moved: string[] = [];
    const ports = deps.listPorts().filter((p) => p.providerId === providerId && p.enabled);
    for (const p of ports) {
      const acc = pickAccount(providerId, { prefer: p.accountId, key: p.key, forPortKey: p.key });
      if (!acc) continue;
      if (acc.id !== p.accountId) {
        deps.setPortAccount(p.key, acc.id);
        moved.push(p.key);
      }
    }
    return moved;
  }

  function moveOnRefusal(targetKey: string): Account | undefined {
    const port = deps.listPorts().find((p) => p.key === targetKey);
    if (!port) return undefined;
    const acc = pickAccount(port.providerId, { exclude: port.accountId, key: targetKey, forPortKey: targetKey });
    if (!acc) return undefined;
    deps.setPortAccount(targetKey, acc.id);
    return acc;
  }

  function atLimit(providerId: ProviderId): boolean {
    const limit = deps.getLimit(providerId);
    if (limit === 0) return false;
    const used = deps.listPorts().filter((p) => p.providerId === providerId && p.enabled).length;
    return used >= limit;
  }

  return { pickAccount, load, rebalance, moveOnRefusal, atLimit };
}
