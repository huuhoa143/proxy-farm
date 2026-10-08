import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortRow, PortState } from '../../shared/contracts';
import { createAccountPool } from '../accounts/pool';
import { createRefusalTracker } from '../accounts/refusals';
import type { SecretStore } from '../store/secrets';
import { createStateStore, type StateStore } from '../store/state';
import type { HmaRead } from './hma-local';
import { createHmaCredsSync } from './hma-sync';
import { wireRefusals } from './refusal-wiring';

function memorySecrets(): SecretStore {
  const m = new Map<string, string>();
  return { saveSecret: (k, v) => void m.set(k, v), loadSecret: (k) => m.get(k) ?? null, deleteSecret: (k) => void m.delete(k) };
}

function row(key: string, accountId: string, state: PortState, providerId: PortRow['providerId'] = 'hma'): PortRow {
  return { key, locationKey: key, providerId, accountId, label: key, country: 'NL', city: 'c', proxyPort: 1, enabled: true, state, autoRotateMin: 0 };
}

let dir: string;
let state: StateStore;
let secrets: SecretStore;
let portStateCb: (key: string, s: PortState) => void;
const onPortState = (cb: (key: string, s: PortState) => void) => {
  portStateCb = cb;
  return () => undefined;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-hmasync-'));
  secrets = memorySecrets();
  state = createStateStore(join(dir, 'state.json'), secrets);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('HMA credentials sync (spec §5.1 lazy apply)', () => {
  let read: HmaRead;
  let watchCb: () => void;
  const restarted: string[] = [];

  function setup() {
    restarted.length = 0;
    secrets.saveSecret('account:hma-1', JSON.stringify({ kind: 'userpass', username: 'U1.old', password: 'p1' }));
    state.setState((s) => ({
      ...s,
      accounts: [{ id: 'hma-1', providerId: 'hma', label: 'd', meta: { source: 'local', udid: 'U1.old' }, secretRef: 'account:hma-1' }],
      ports: [
        row('hma:A', 'hma-1', { kind: 'online', since: 1, exitIp: '1.1.1.1', country: 'NL' }),
        row('hma:B', 'hma-1', { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 }),
        { ...row('hma:C', 'hma-1', { kind: 'stopped' }), enabled: false },
      ],
    }));
    return createHmaCredsSync({
      source: { read: async () => read, watch: (cb) => ((watchCb = cb), () => undefined) },
      state,
      secrets,
      onPortState,
      restartPort: (k) => restarted.push(k),
    });
  }

  it('ignores a rewrite that keeps the same udid/password (token-only session renewal)', async () => {
    const sync = setup();
    read = { status: 'found', creds: { udid: 'U1.old', password: 'p1' } };
    expect(await sync.check()).toEqual([]);
    expect(restarted).toEqual([]);
  });

  it('saves changed creds; restarts a down port now, a working one only once it drops; never a disabled one', async () => {
    const sync = setup();
    read = { status: 'found', creds: { udid: 'U1.new', password: 'p2' } };
    expect(await sync.check()).toEqual(['hma-1']);
    expect(JSON.parse(secrets.loadSecret('account:hma-1')!)).toEqual({ kind: 'userpass', username: 'U1.new', password: 'p2' });
    expect(state.getState().accounts[0].meta.udid).toBe('U1.new');
    expect(restarted).toEqual(['hma:B']);

    portStateCb('hma:A', { kind: 'online', since: 2, exitIp: '1.1.1.1', country: 'NL' });
    expect(restarted).toEqual(['hma:B']);
    portStateCb('hma:A', { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'unreachable' });
    expect(restarted).toEqual(['hma:B', 'hma:A']);
    portStateCb('hma:A', { kind: 'retrying', untilMs: 0, attempt: 2, reasonKey: 'unreachable' });
    expect(restarted).toEqual(['hma:B', 'hma:A']); // once only
  });

  it('re-checks when the watched file changes', async () => {
    setup();
    read = { status: 'found', creds: { udid: 'U1.new', password: 'p2' } };
    watchCb();
    await new Promise((r) => setTimeout(r, 10));
    expect(restarted).toEqual(['hma:B']);
  });
});

describe('refusal wiring (spec §5.2 move on refusal)', () => {
  function setup(accounts: string[]) {
    const refusals = createRefusalTracker();
    state.setState((s) => ({
      ...s,
      accounts: accounts.map((id) => ({ id, providerId: 'zoogvpn' as const, label: id, meta: {}, secretRef: id })),
      ports: [row('zoogvpn:a', 'z1', { kind: 'online', since: 1, exitIp: '1', country: 'NL' }, 'zoogvpn'), row('zoogvpn:b', 'z1', { kind: 'connecting', since: 1 }, 'zoogvpn')],
    }));
    const pool = createAccountPool({
      listAccounts: () => state.getState().accounts,
      listPorts: () => state.getState().ports,
      setPortAccount: (key, accountId) => state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, accountId } : p)) })),
      getLimit: () => 0,
      isUsable: () => true,
      refusals,
    });
    const restarted: string[] = [];
    wireRefusals({ state, refusals, pool, onPortState, restartPort: (k) => restarted.push(k) });
    return { refusals, restarted };
  }

  const authFail: PortState = { kind: 'failed', reason: 'auth', untilMs: 5, attempt: 1 };

  it('moves a not-in-plan port to another account and restarts it', () => {
    const { refusals, restarted } = setup(['z1', 'z2']);
    refusals.recordOnline('z1', 'zoogvpn:a');
    refusals.recordAuthFailure('z1', 'zoogvpn:b');
    portStateCb('zoogvpn:b', authFail);
    expect(state.getState().ports[1].accountId).toBe('z2');
    expect(restarted).toEqual(['zoogvpn:b']);
  });

  it('relabels it failed(not-in-plan) when no other account can take it', () => {
    const { refusals, restarted } = setup(['z1']);
    refusals.recordOnline('z1', 'zoogvpn:a');
    refusals.recordAuthFailure('z1', 'zoogvpn:b');
    state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === 'zoogvpn:b' ? { ...p, state: authFail } : p)) }));
    portStateCb('zoogvpn:b', authFail);
    expect(restarted).toEqual([]);
    expect(state.getState().ports[1].state).toEqual({ ...authFail, reason: 'not-in-plan' });
  });

  it('leaves an undecided auth failure alone', () => {
    const { refusals, restarted } = setup(['z1', 'z2']);
    refusals.recordAuthFailure('z1', 'zoogvpn:b');
    portStateCb('zoogvpn:b', authFail);
    expect(restarted).toEqual([]);
    expect(state.getState().ports[1].accountId).toBe('z1');
  });
});
