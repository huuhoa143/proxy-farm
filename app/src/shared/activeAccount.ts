import type { Account, ProviderId } from './contracts';

/**
 * The "one active account per provider" model.
 *
 * A VPN provider's servers/exit IPs are shared infrastructure, not per-account: two accounts
 * of the same provider connecting to the same location get the same IP pool. So adding more
 * accounts adds no IPs — only one account need be *active* (used by the controller) at a time;
 * the rest are kept but idle. More exit IPs come from more locations, not more accounts.
 *
 * The `file` provider is the exception: each imported config is its own distinct server, so
 * every file account stays usable (no single "active" one).
 */

export const ACTIVE_META_KEY = 'active';

/** Whether a provider uses the single-active-account model (every provider except `file`). */
export function usesActiveAccountModel(providerId: ProviderId): boolean {
  return providerId !== 'file';
}

/**
 * The active account id for a provider: the account flagged `meta.active==='1'`, else the
 * first account of that provider (the default), else undefined. Returns undefined for a
 * provider that does not use the model (e.g. `file`) — there every account is usable.
 */
export function activeAccountId(accounts: readonly Account[], providerId: ProviderId): string | undefined {
  if (!usesActiveAccountModel(providerId)) return undefined;
  const mine = accounts.filter((a) => a.providerId === providerId);
  return (mine.find((a) => a.meta[ACTIVE_META_KEY] === '1') ?? mine[0])?.id;
}

/**
 * Whether `account` is the one the controller should use for its provider. True for every
 * account of a provider that does not use the model (`file`); otherwise only the active one.
 */
export function isActiveAccount(account: Account, accounts: readonly Account[]): boolean {
  if (!usesActiveAccountModel(account.providerId)) return true;
  return activeAccountId(accounts, account.providerId) === account.id;
}
