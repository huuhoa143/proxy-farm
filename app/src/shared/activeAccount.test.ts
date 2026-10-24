import { describe, expect, it } from 'vitest';
import type { Account, ProviderId } from './contracts';
import { ACTIVE_META_KEY, activeAccountId, isActiveAccount, usesActiveAccountModel } from './activeAccount';

function acc(id: string, providerId: ProviderId, meta: Record<string, string> = {}): Account {
  return { id, providerId, label: id, meta, secretRef: `account:${id}` };
}

describe('activeAccount model', () => {
  it('defaults the active account to the first of its provider', () => {
    const list = [acc('ss-1', 'surfshark'), acc('ss-2', 'surfshark')];
    expect(activeAccountId(list, 'surfshark')).toBe('ss-1');
    expect(isActiveAccount(list[0], list)).toBe(true);
    expect(isActiveAccount(list[1], list)).toBe(false);
  });

  it('honours an explicit meta.active flag', () => {
    const list = [acc('ss-1', 'surfshark'), acc('ss-2', 'surfshark', { [ACTIVE_META_KEY]: '1' })];
    expect(activeAccountId(list, 'surfshark')).toBe('ss-2');
    expect(isActiveAccount(list[1], list)).toBe(true);
    expect(isActiveAccount(list[0], list)).toBe(false);
  });

  it('is per-provider', () => {
    const list = [acc('ss-1', 'surfshark'), acc('hma-1', 'hma'), acc('hma-2', 'hma', { [ACTIVE_META_KEY]: '1' })];
    expect(activeAccountId(list, 'surfshark')).toBe('ss-1');
    expect(activeAccountId(list, 'hma')).toBe('hma-2');
  });

  it('undefined when the provider has no accounts', () => {
    expect(activeAccountId([acc('ss-1', 'surfshark')], 'hma')).toBeUndefined();
  });

  it('exempts the file provider: every file account is active/usable', () => {
    expect(usesActiveAccountModel('file')).toBe(false);
    const files = [acc('file-1', 'file'), acc('file-2', 'file')];
    expect(activeAccountId(files, 'file')).toBeUndefined();
    expect(isActiveAccount(files[0], files)).toBe(true);
    expect(isActiveAccount(files[1], files)).toBe(true);
  });

  it('every other provider uses the model', () => {
    for (const p of ['hma', 'surfshark', 'nordvpn', 'zoogvpn', 'expressvpn'] as const) {
      expect(usesActiveAccountModel(p)).toBe(true);
    }
  });
});
