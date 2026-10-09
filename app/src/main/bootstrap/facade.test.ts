import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PortRow, Provider, ProviderId, RotateResult, Target } from '../../shared/contracts';
import { createAccountPool } from '../accounts/pool';
import { createRefusalTracker } from '../accounts/refusals';
import type { CredentialVerdict, PortManager } from '../controller/port-manager';
import type { StartQueue } from '../controller/start-queue';
import type { SecretStore } from '../store/secrets';
import { createStateStore, type StateStore } from '../store/state';
import { createControllerFacade, guessCountry, rotateNoteKey, type FacadeDeps } from './facade';
import type { HmaRead } from './hma-local';
import { createNordvpnProvider } from '../providers/nordvpn';
import { wgKeyLabel } from '../providers/wg-key';

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    saveSecret: (id, v) => void map.set(id, v),
    loadSecret: (id) => map.get(id) ?? null,
    deleteSecret: (id) => void map.delete(id),
  };
}

const HMA_UDID = 'U1.00000000-0000-0000-0000-000000000000.hma201';
const HMA_PASS = 'a'.repeat(64);

function target(key: string, country = 'NL', servers = ['10.0.0.1']): Target {
  const providerId = key.split(':')[0] as ProviderId;
  return { key, providerId, country, city: key.split(':')[1], label: key, servers };
}

/** A provider fake with real-shaped check() rules (format only). */
function fakeProvider(id: ProviderId, targets: (account: Account) => Target[]): Provider {
  return {
    id,
    check(input): ReturnType<Provider['check']> {
      if (id === 'hma') {
        if (!input.udid?.startsWith('U1.')) return { ok: false, reasonKey: 'hma.check.invalidUdid' };
        return { ok: true, label: `device …${input.udid.slice(-6)}`, secret: { kind: 'userpass', username: input.udid, password: input.password }, meta: { udid: input.udid } };
      }
      if (id === 'zoogvpn') {
        if (!input.username) return { ok: false, reasonKey: 'zoogvpn.check.missingUsername' };
        return { ok: true, label: input.username, secret: { kind: 'userpass', username: input.username, password: input.password }, meta: { username: input.username } };
      }
      if (id === 'file') {
        if (!input.name.endsWith('.conf')) return { ok: false, reasonKey: 'file.check.unknownExtension' };
        return { ok: true, label: '127.0.0.1:51999', secret: { kind: 'file', content: input.content }, meta: { format: 'wireguard', host: '127.0.0.1', port: '51999' } };
      }
      return { ok: false, reasonKey: 'x' };
    },
    targets: async (account) => targets(account),
    bind: () => {
      throw new Error('not used');
    },
  };
}

/** Pins each new port to the first server of the location no other row holds, like the
 * real one (per account: `refusedFor` lists servers that account may not use). */
function fakePortManager(state: StateStore, refusedFor: Record<string, string[]> = {}) {
  const calls: string[] = [];
  let verdict: CredentialVerdict = 'unsupported';
  let rotateResult: RotateResult = { changed: true, from: '1.1.1.1', to: '2.2.2.2' };
  const held = (t: Target) => new Set(state.getState().ports.filter((p) => p.locationKey === t.key).map((p) => p.server));
  let addLock: Promise<unknown> = Promise.resolve();
  const pm: PortManager & { calls: string[]; setRotate(r: RotateResult): void; setVerdict(v: CredentialVerdict): void } = {
    calls,
    setRotate: (r) => (rotateResult = r),
    setVerdict: (v) => (verdict = v),
    startPort: async (key) => void calls.push(`start:${key}`),
    stopPort: async (key) => {
      calls.push(`stop:${key}`);
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, enabled: false, state: { kind: 'stopped' } } : p)) }));
    },
    removePort: async (key) => {
      calls.push(`remove:${key}`);
      state.setState((s) => ({ ...s, ports: s.ports.filter((p) => p.key !== key) }));
    },
    rotatePort: async (key, toServer) => {
      calls.push(`rotate:${key}${toServer ? `>${toServer}` : ''}`);
      return rotateResult;
    },
    setAutoRotate: async () => undefined,
    exportPorts: async () => '',
    testPort: async () => ({ ok: true, exitIp: '9.9.9.9', latencyMs: 12 }),
    // Serialized, with the limit asked under that lock, like the real one; it yields
    // first, as the real one does while it resolves servers.
    addPort: (t, accountId, opts) => {
      const run = addLock.then(async () => {
        await new Promise((r) => setTimeout(r, 0));
        if (opts?.atLimit?.()) return undefined;
        const server = t.servers.find((sv) => !held(t).has(sv) && !(refusedFor[accountId] ?? []).includes(sv));
        if (!server) return undefined;
        const used = new Set(state.getState().ports.map((p) => p.proxyPort));
        let proxyPort = 29001;
        while (used.has(proxyPort)) proxyPort += 1;
        const n = state.getState().ports.filter((p) => p.locationKey === t.key).length + 1;
        const row: PortRow = { key: `${t.key}#${n}`, locationKey: t.key, server, providerId: t.providerId, accountId, label: t.label, country: t.country, city: t.city, proxyPort, enabled: true, state: { kind: 'queued' }, autoRotateMin: 0 };
        state.setState((s) => ({ ...s, ports: [...s.ports, row] }));
        return row;
      });
      addLock = run.then(() => undefined);
      return run;
    },
    listServers: async (t) => t.servers.map((server) => ({ server, health: 'unknown' as const, ...(held(t).has(server) ? { heldBy: 'x' } : {}) })),
    freeServerCount: (t) => t.servers.filter((sv) => !held(t).has(sv)).length,
    // Not in plan when every server is refused for every account (refusedFor['*']).
    locationNotInPlan: (t) => t.servers.length > 0 && t.servers.every((sv) => (refusedFor['*'] ?? []).includes(sv)),
    syncAutoRotate: () => undefined,
    stopAutoRotate: () => undefined,
    credentialsChanged: (accountId) => void calls.push(`creds:${accountId}`),
    checkCredentials: async (account, secret) => {
      calls.push(`check:${account.id}:${secret.kind === 'userpass' ? secret.password : secret.kind}`);
      return verdict;
    },
    recordCredentialCheck: (accountId, v) => void calls.push(`record:${accountId}:${v}`),
  };
  return pm;
}

function fakeQueue(): StartQueue & { enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    enqueued,
    enqueue: (key) => void enqueued.push(key),
    cancel: () => undefined,
    clear: () => undefined,
    isQueued: (key) => enqueued.includes(key),
    inFlight: 0,
    peak: 0,
  };
}

describe('controller facade', () => {
  let dir: string;
  let hmaRead: HmaRead;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-facade-'));
    hmaRead = { status: 'found', creds: { udid: HMA_UDID, password: HMA_PASS } };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(overrides: Partial<FacadeDeps> = {}, refusedFor: Record<string, string[]> = {}) {
    const secrets = memorySecrets();
    const state = createStateStore(join(dir, 'state.json'), secrets);
    const refusals = createRefusalTracker();
    const pool = createAccountPool({
      listAccounts: () => state.getState().accounts,
      listPorts: () => state.getState().ports,
      setPortAccount: () => undefined,
      getLimit: (id) => state.getState().limits[id] ?? 0,
      isUsable: () => true,
      refusals,
    });
    const providers: Record<string, Provider> = {
      hma: fakeProvider('hma', () => [target('hma:NL-AMS', 'NL', ['10.0.0.1', '10.0.0.2', '10.0.0.3']), target('hma:JP-TYO', 'JP')]),
      zoogvpn: fakeProvider('zoogvpn', () => [target('zoogvpn:nl1')]),
      file: fakeProvider('file', (a) => [{ ...target(`file:${a.id}`, a.meta.country), city: a.meta.city }]),
    };
    const portManager = fakePortManager(state, refusedFor);
    const queue = fakeQueue();
    const allocated: number[] = [];
    const speedTest = vi.fn(async () => 42.5);
    const onSettingsChanged = vi.fn();
    const updater = {
      getStatus: vi.fn(() => ({ phase: 'available', currentVersion: '1.2.3', availableVersion: '2.0.0' }) as const),
      checkForUpdates: vi.fn(async () => ({ phase: 'up-to-date', currentVersion: '1.2.3' }) as const),
      downloadAndInstall: vi.fn(async () => ({ success: true })),
    };
    const deps: FacadeDeps = {
      state,
      secrets,
      providers: { get: (id) => providers[id] },
      portManager,
      pool,
      queue,
      allocator: {
        allocate: async (opts) => {
          let p = opts?.base ?? 29001;
          while (opts?.taken?.has(p)) p += 1;
          allocated.push(p);
          return p;
        },
        allocateAux: async () => 40000,
        release: () => undefined,
      },
      engineLogs: (key) => [`log for ${key}`],
      hostVpn: { isHostVpnActive: async () => true },
      hma: { read: async () => hmaRead, watch: () => () => undefined },
      platform: 'darwin',
      speedTest,
      onSettingsChanged,
      appStatus: () => ({ secretsUnavailable: true }),
      updater,
      diagnosticsEnv: () => ({
        appVersion: '1.2.3',
        os: { platform: 'darwin', release: '23.4.0', arch: 'arm64' },
        versions: { electron: '42.0.1', chrome: '140.0.0.0', node: '22.0.0' },
        singBox: '1.14.2',
      }),
      log: () => undefined,
      ...overrides,
    };
    return { facade: createControllerFacade(deps), state, secrets, portManager, queue, allocated, speedTest, onSettingsChanged, updater };
  }

  it('listProviders reports HMA detection and each provider limit (Ruling C)', async () => {
    const { facade, state } = setup();
    state.setState((s) => ({ ...s, limits: { ...s.limits, zoogvpn: 3 } }));
    const list = await facade.listProviders();
    expect(list.map((p) => p.id)).toEqual(['hma', 'zoogvpn', 'surfshark', 'nordvpn', 'expressvpn', 'file']);
    expect(list[0].detected).toEqual({ found: true });
    expect(list[1].limit).toBe(3);
    expect(list[2].limit).toBe(0);
    // NordVPN's and ExpressVPN's default limits until the user sets one; an explicit 0 (unlimited) wins.
    expect(list[3].limit).toBe(6);
    expect(list[4].limit).toBe(8);
    state.setState((s) => ({ ...s, limits: { ...s.limits, nordvpn: 0 } }));
    expect((await facade.listProviders())[3].limit).toBe(0);
  });

  it('listProviders maps a missing / unreadable HMA install to not-found hints', async () => {
    const { facade } = setup();
    hmaRead = { status: 'missing' };
    expect((await facade.listProviders())[0].detected).toEqual({ found: false });
    hmaRead = { status: 'invalid', message: 'x' };
    expect((await facade.listProviders())[0].detected).toEqual({ found: false, hintKey: 'hma.notSignedIn' });
    hmaRead = { status: 'helper-missing' };
    expect((await facade.listProviders())[0].detected).toEqual({ found: false, hintKey: 'hma.helperMissing' });
  });

  it('connectHma stores the device creds as a userpass secret, and a second connect updates the same account', async () => {
    const { facade, state, secrets } = setup();
    const first = await facade.connectHma();
    expect(first.ok).toBe(true);
    expect(first.account?.meta.source).toBe('local');
    const stored = JSON.parse(secrets.loadSecret(first.account!.secretRef)!);
    expect(stored).toEqual({ kind: 'userpass', username: HMA_UDID, password: HMA_PASS });
    expect(JSON.stringify(state.getState().accounts)).not.toContain(HMA_PASS);

    hmaRead = { status: 'found', creds: { udid: HMA_UDID, password: 'b'.repeat(64) } };
    const second = await facade.connectHma();
    expect(second.account?.id).toBe(first.account?.id);
    expect(state.getState().accounts).toHaveLength(1);
    expect(JSON.parse(secrets.loadSecret(first.account!.secretRef)!).password).toBe('b'.repeat(64));
  });

  it('a re-import with a changed secret drops server marks earned under the old one; an unchanged one does not', async () => {
    const { facade, portManager } = setup();
    await facade.connectHma();
    await facade.connectHma(); // same creds
    expect(portManager.calls.filter((c) => c.startsWith('creds:'))).toEqual([]);
    hmaRead = { status: 'found', creds: { udid: HMA_UDID, password: 'b'.repeat(64) } };
    await facade.connectHma();
    expect(portManager.calls.filter((c) => c.startsWith('creds:'))).toEqual(['creds:hma-1']);

    await facade.addAccount('zoogvpn', { username: 'me', password: 'old' });
    await facade.addAccount('zoogvpn', { username: 'me', password: 'new' }); // the duplicate-account path
    expect(portManager.calls.filter((c) => c.startsWith('creds:'))).toEqual(['creds:hma-1', 'creds:zoogvpn-1']);
  });

  it('re-adding a Surfshark key with a corrected address updates the account meta and counts as new credentials', async () => {
    const surfshark: Provider = {
      ...fakeProvider('surfshark', () => []),
      check: (input) => ({ ok: true, label: 'key …abcdef', secret: { kind: 'wgkey', privateKey: 'k' }, meta: { address: input.address } }),
    };
    const { facade, state, portManager } = setup({ providers: { get: (id) => (id === 'surfshark' ? surfshark : undefined) } });
    await facade.addAccount('surfshark', { privateKey: 'k', address: '10.14.0.2/16' });
    await facade.addAccount('surfshark', { privateKey: 'k', address: '10.14.0.2/16' }); // nothing changed
    expect(portManager.calls.filter((c) => c.startsWith('creds:'))).toEqual([]);
    const r = await facade.addAccount('surfshark', { privateKey: 'k', address: '10.64.1.2/16' });
    expect(r.account?.meta).toEqual({ address: '10.64.1.2/16' });
    expect(state.getState().accounts).toHaveLength(1);
    expect(state.getState().accounts[0].meta).toEqual({ address: '10.64.1.2/16' });
    expect(portManager.calls.filter((c) => c.startsWith('creds:'))).toEqual(['creds:surfshark-1']);
  });

  it('re-adding a key whose account kept its legacy label (secret lost) repairs that account, not a twin', async () => {
    const KEY = 'kNWOz8Z0Ft2V0vHn8bU1Hc0w2m9yBq7Ri3sXkQe1hGc=';
    const surfshark: Provider = {
      ...fakeProvider('surfshark', () => []),
      check: () => ({ ok: true, label: wgKeyLabel(KEY), secret: { kind: 'wgkey', privateKey: KEY }, meta: {} }),
    };
    const { facade, state, secrets, portManager } = setup({ providers: { get: (id) => (id === 'surfshark' ? surfshark : undefined) } });
    // As `migrateKeyLabels` leaves it when the keychain lost the secret: legacy label, no secret.
    state.setState((s) => ({
      ...s,
      accounts: [{ id: 'surfshark-1', providerId: 'surfshark', label: `key …${KEY.slice(-6)}`, meta: {}, secretRef: 'account:surfshark-1' }],
    }));
    const r = await facade.addAccount('surfshark', { privateKey: KEY });
    expect(r).toMatchObject({ ok: true, label: wgKeyLabel(KEY) });
    expect(state.getState().accounts).toEqual([expect.objectContaining({ id: 'surfshark-1', label: wgKeyLabel(KEY) })]);
    expect(JSON.parse(secrets.loadSecret('account:surfshark-1')!)).toEqual({ kind: 'wgkey', privateKey: KEY });
    expect(portManager.calls.filter((c) => c.startsWith('creds:'))).toEqual(['creds:surfshark-1']);
  });

  describe('addAccount(nordvpn): an access token is exchanged once and never stored (spec §5.5)', () => {
    const TOKEN = 'cd'.repeat(32);
    const KEY = 'kNWOz8Z0Ft2V0vHn8bU1Hc0w2m9yBq7Ri3sXkQe1hGc=';

    function nordSetup(answer: { status: number; body?: unknown }) {
      const fetchImpl = vi.fn(async () => ({ ok: answer.status === 200, status: answer.status, json: async () => answer.body }));
      const nordvpn = createNordvpnProvider({ cachePath: join(dir, 'cache', 'nordvpn-servers.json'), fetchImpl });
      const env = setup({ providers: { get: (id) => (id === 'nordvpn' ? nordvpn : undefined) } });
      return { ...env, fetchImpl };
    }

    it('a token → the NordLynx key is stored as a wgkey secret; the token is nowhere', async () => {
      const { facade, state, secrets, fetchImpl, portManager } = nordSetup({ status: 200, body: { username: 'u', password: 'p', nordlynx_private_key: KEY } });
      const r = await facade.addAccount('nordvpn', { credential: ` ${TOKEN} ` });
      expect(r).toMatchObject({ ok: true, label: wgKeyLabel(KEY) });
      expect(r.label).not.toContain(KEY.slice(-6, -1));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(secrets.loadSecret(r.account!.secretRef)!)).toEqual({ kind: 'wgkey', privateKey: KEY });
      expect(JSON.stringify(state.getState())).not.toContain(TOKEN);
      // A WireGuard key has no live login check (that is the OpenVPN credential probe).
      expect(portManager.calls.filter((c) => c.startsWith('check:'))).toEqual([]);
    });

    it('a pasted NordLynx key is stored without any network call', async () => {
      const { facade, secrets, fetchImpl } = nordSetup({ status: 500 });
      const r = await facade.addAccount('nordvpn', { credential: KEY });
      expect(r.ok).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.parse(secrets.loadSecret(r.account!.secretRef)!)).toEqual({ kind: 'wgkey', privateKey: KEY });
    });

    it('a refused token, a network error or malformed input store nothing', async () => {
      for (const [answer, input, reasonKey] of [
        [{ status: 401 }, TOKEN, 'nordvpn.check.tokenRejected'],
        [{ status: 503 }, TOKEN, 'nordvpn.check.networkError'],
        [{ status: 200 }, 'not a token or a key', 'nordvpn.check.invalidInput'],
      ] as const) {
        const { facade, state } = nordSetup(answer);
        expect(await facade.addAccount('nordvpn', { credential: input })).toEqual({ ok: false, reasonKey });
        expect(state.getState().accounts).toHaveLength(0);
      }
    });
  });

  it('connectHma: not installed → hma.notFound; Windows without HMA support → hma.helperMissing', async () => {
    hmaRead = { status: 'missing' };
    expect(await setup().facade.connectHma()).toEqual({ ok: false, reasonKey: 'hma.notFound' });
    expect(await setup({ platform: 'linux' }).facade.connectHma()).toEqual({ ok: false, reasonKey: 'hma.notFound' });
    hmaRead = { status: 'helper-missing' };
    expect(await setup({ platform: 'win32' }).facade.connectHma()).toEqual({ ok: false, reasonKey: 'hma.helperMissing' });
  });

  it('connectHma on Windows adds the account from the auth file credentials', async () => {
    const udid = `U1.00000000-0000-4000-8000-000000000000.hma101.${'A'.repeat(64)}`;
    hmaRead = { status: 'found', creds: { udid, password: 'B'.repeat(64) } };
    const r = await setup({ platform: 'win32' }).facade.connectHma();
    expect(r.ok).toBe(true);
    expect(r.account?.meta).toMatchObject({ udid, source: 'local' });
  });

  it('enableHmaSupport: nothing to do off Windows; on Windows maps the setup outcome', async () => {
    expect(await setup().facade.enableHmaSupport()).toEqual({ ok: true });
    for (const [result, expected] of [
      [{ ok: true }, { ok: true }],
      [{ ok: false, reason: 'cancelled' }, { ok: false, reasonKey: 'hma.enable.cancelled' }],
      [{ ok: false, reason: 'no-credentials' }, { ok: false, reasonKey: 'hma.enable.no-credentials' }],
      [{ ok: false, reason: 'failed' }, { ok: false, reasonKey: 'hma.enable.failed' }],
    ] as const) {
      const hmaWindows = { enable: async () => result, refresh: async () => undefined };
      expect(await setup({ platform: 'win32', hmaWindows }).facade.enableHmaSupport()).toEqual(expected);
    }
  });

  it('addAccount(zoogvpn) maps the card\'s "email" field to the provider\'s username', async () => {
    const { facade, secrets } = setup();
    const r = await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'pw' });
    expect(r.ok).toBe(true);
    expect(JSON.parse(secrets.loadSecret(r.account!.secretRef)!)).toEqual({ kind: 'userpass', username: 'me@example.com', password: 'pw' });
    expect(await facade.addAccount('zoogvpn', { password: 'pw' })).toMatchObject({ ok: false, reasonKey: 'zoogvpn.check.missingUsername' });
  });

  describe('addAccount: one live login check before an email/password is stored (spec §5.2)', () => {
    it('verified → stored, the verdict recorded', async () => {
      const { facade, portManager, state } = setup();
      portManager.setVerdict('verified');
      const r = await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'pw' });
      expect(r).toMatchObject({ ok: true, label: 'me@example.com' });
      expect(r.noteKey).toBeUndefined();
      expect(portManager.calls.filter((c) => c.startsWith('check:') || c.startsWith('record:'))).toEqual(['check:zoogvpn-1:pw', 'record:zoogvpn-1:verified']);
      expect(state.getState().accounts).toHaveLength(1);
    });

    it('rejected by the free-tier server → "wrong email or password", nothing stored', async () => {
      const { facade, portManager, state, secrets } = setup();
      portManager.setVerdict('rejected');
      expect(await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'bad' })).toEqual({
        ok: false,
        reasonKey: 'zoogvpn.check.wrongCredentials',
        label: 'me@example.com',
      });
      expect(state.getState().accounts).toEqual([]);
      expect(secrets.loadSecret('account:zoogvpn-1')).toBeNull();
    });

    it('a wrong new password for an existing account keeps the old one', async () => {
      const { facade, portManager, secrets } = setup();
      portManager.setVerdict('verified');
      const first = await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'good' });
      portManager.setVerdict('rejected');
      expect((await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'typo' })).ok).toBe(false);
      expect(JSON.parse(secrets.loadSecret(first.account!.secretRef)!).password).toBe('good');
      expect(portManager.calls).not.toContain('creds:zoogvpn-1');
    });

    it('no free-tier server reachable → accepted but marked unverified, with a note', async () => {
      const { facade, portManager } = setup();
      portManager.setVerdict('unverified');
      const r = await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'pw' });
      expect(r).toMatchObject({ ok: true, noteKey: 'zoogvpn.check.unverified' });
      expect(portManager.calls).toContain('record:zoogvpn-1:unverified');
    });

    it('new credentials that check out restart the account\'s terminally failed ports (a user action)', async () => {
      const { facade, portManager, state, queue } = setup();
      portManager.setVerdict('verified');
      const { account } = await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'old' });
      const failed = (key: string, reason: 'auth' | 'not-in-plan'): PortRow => ({
        key, locationKey: key.split('#')[0], providerId: 'zoogvpn', accountId: account!.id, label: 'X', country: 'JP', city: 'Japan',
        proxyPort: 29001 + queue.enqueued.length, enabled: true, state: { kind: 'failed', reason, untilMs: 0, attempt: 1 }, autoRotateMin: 0,
      });
      state.setState((s) => ({ ...s, ports: [failed('zoogvpn:JP#1', 'auth'), failed('zoogvpn:DE#1', 'not-in-plan')] }));
      // Same password, checked again: only the sign-in failure is retried.
      await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'old' });
      expect(queue.enqueued).toEqual(['zoogvpn:JP#1']);
      state.setState((s) => ({ ...s, ports: [failed('zoogvpn:JP#1', 'auth'), failed('zoogvpn:DE#1', 'not-in-plan')] }));
      // A new password: every terminal failure of the account is retried.
      await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'new' });
      expect(queue.enqueued).toEqual(['zoogvpn:JP#1', 'zoogvpn:JP#1', 'zoogvpn:DE#1']);
    });

    it('only an email/password login is probed (not a WireGuard key)', async () => {
      const surfshark: Provider = {
        ...fakeProvider('surfshark', () => []),
        check: () => ({ ok: true, label: 'key …abcdef', secret: { kind: 'wgkey', privateKey: 'k' }, meta: {} }),
      };
      const { facade, portManager } = setup({ providers: { get: (id) => (id === 'surfshark' ? surfshark : undefined) } });
      await facade.addAccount('surfshark', { privateKey: 'k' });
      expect(portManager.calls.some((c) => c.startsWith('check:'))).toBe(false);
    });
  });

  it('importConfigFile hands a username/password to the file check (an .ovpn with auth-user-pass)', async () => {
    const check = vi.fn((_input: Record<string, string>) => ({ ok: false, reasonKey: 'file.check.needsCredentials' }) as ReturnType<Provider['check']>);
    const { facade } = setup({ providers: { get: (id) => (id === 'file' ? { ...fakeProvider('file', () => []), check } : undefined) } });
    await facade.importConfigFile('vn.ovpn', 'auth-user-pass', 'VN', { username: 'me', password: 'pw' });
    expect(check).toHaveBeenLastCalledWith({ name: 'vn.ovpn', content: 'auth-user-pass', username: 'me', password: 'pw' });
    await facade.importConfigFile('vn.ovpn', 'auth-user-pass', 'VN');
    expect(check).toHaveBeenLastCalledWith({ name: 'vn.ovpn', content: 'auth-user-pass' });
  });

  it('importConfigFile honours the country override, else guesses it from the file name', async () => {
    const { facade } = setup();
    const a = await facade.importConfigFile('home.conf', '[Interface]', 'se');
    expect(a.account?.meta).toMatchObject({ country: 'SE', city: 'home' });
    const b = await facade.importConfigFile('mullvad-de-ber.conf', '[Interface]');
    expect(b.account?.meta.country).toBe('DE');
    expect(await facade.importConfigFile('x.txt', '')).toMatchObject({ ok: false, reasonKey: 'file.check.unknownExtension' });
  });

  it('startPorts: a bare location key adds one port (account from the pool, a port row, through the queue)', async () => {
    const { facade, state, queue } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS', 'hma:JP-TYO', 'hma:NOPE']);
    const rows = state.getState().ports;
    expect(rows.map((r) => [r.key, r.proxyPort, r.enabled, r.state.kind])).toEqual([
      ['hma:NL-AMS#1', 29001, true, 'queued'],
      ['hma:JP-TYO#1', 29002, true, 'queued'],
    ]);
    expect(rows[0].accountId).toBe('hma-1');
    expect(queue.enqueued).toEqual(['hma:NL-AMS#1', 'hma:JP-TYO#1']);
  });

  it('startPorts: a port key starts that port; an unknown port key is ignored', async () => {
    const { facade, state, queue } = setup();
    await facade.connectHma();
    await facade.addPorts('hma:NL-AMS', 1);
    state.setState((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p, enabled: false, state: { kind: 'stopped' } })) }));
    queue.enqueued.length = 0;
    await facade.startPorts(['hma:NL-AMS#1', 'hma:NL-AMS#7']);
    expect(queue.enqueued).toEqual(['hma:NL-AMS#1']);
    expect(state.getState().ports).toHaveLength(1);
  });

  it('addPorts adds k ports on different servers and starts them', async () => {
    const { facade, state, queue } = setup();
    await facade.connectHma();
    const r = await facade.addPorts('hma:NL-AMS', 2);
    expect(r.noteKey).toBeUndefined();
    expect(r.added.map((p) => [p.key, p.server])).toEqual([
      ['hma:NL-AMS#1', '10.0.0.1'],
      ['hma:NL-AMS#2', '10.0.0.2'],
    ]);
    expect(queue.enqueued).toEqual(['hma:NL-AMS#1', 'hma:NL-AMS#2']);
    expect(state.getState().ports.every((p) => p.enabled && p.state.kind === 'queued')).toBe(true);
  });

  it('addPorts with fewer free servers adds that many and says no-free-server', async () => {
    const { facade } = setup();
    await facade.connectHma();
    const r = await facade.addPorts('hma:NL-AMS', 5);
    expect(r.added).toHaveLength(3);
    expect(r.noteKey).toBe('no-free-server');
    expect(await facade.addPorts('hma:NL-AMS', 1)).toEqual({ added: [], noteKey: 'no-free-server' });
  });

  it('addPorts stops at the provider limit with limit-reached', async () => {
    const { facade } = setup();
    await facade.connectHma();
    await facade.setLimit('hma', 2);
    const r = await facade.addPorts('hma:NL-AMS', 3);
    expect(r.added).toHaveLength(2);
    expect(r.noteKey).toBe('limit-reached');
  });

  it('two concurrent addPorts with one slot left add exactly one port; the other says limit-reached', async () => {
    const { facade, state } = setup();
    await facade.connectHma();
    await facade.setLimit('hma', 2);
    await facade.addPorts('hma:NL-AMS', 1);
    const [a, b] = await Promise.all([facade.addPorts('hma:NL-AMS', 1), facade.addPorts('hma:NL-AMS', 1)]);
    expect(a.added.length + b.added.length).toBe(1);
    expect([a.noteKey, b.noteKey].filter(Boolean)).toEqual(['limit-reached']);
    expect(state.getState().ports.filter((p) => p.enabled)).toHaveLength(2);
  });

  it('addPorts is not capped at one port for a round-robin pool hostname; the port manager decides', async () => {
    const tok: Target = { ...target('surfshark:jp-tok', 'JP', ['jp-tok.prod.surfshark.com']), poolHostnames: true };
    const surfshark = fakeProvider('surfshark', () => [tok]);
    const { facade, state, portManager } = setup({ providers: { get: (id) => (id === 'surfshark' ? surfshark : undefined) } });
    state.setState((s) => ({ ...s, accounts: [{ id: 'surfshark-1', providerId: 'surfshark', label: 'k', meta: {}, secretRef: 'account:surfshark-1' }] }));
    // Two distinct IPs behind the hostname, then every answer is held.
    let n = 0;
    const realAdd = portManager.addPort;
    portManager.addPort = async (t, accountId) => (++n <= 2 ? realAdd({ ...t, servers: [`203.0.113.${n}`] }, accountId) : undefined);
    const r = await facade.addPorts('surfshark:jp-tok', 3);
    expect(r.added).toHaveLength(2);
    expect(r.noteKey).toBe('no-free-server');
  });

  it('addPorts tries another account when the pooled one has no usable free server', async () => {
    const { facade } = setup({}, { 'zoogvpn-1': ['10.0.0.1'] });
    await facade.addAccount('zoogvpn', { username: 'a', password: 'p' });
    await facade.addAccount('zoogvpn', { username: 'b', password: 'p' });
    const r = await facade.addPorts('zoogvpn:nl1', 1);
    expect(r.added.map((p) => p.accountId)).toEqual(['zoogvpn-2']);
  });

  it('listServers / listTargets come from the port manager, with freeServers filled in', async () => {
    const { facade, portManager } = setup();
    await facade.connectHma();
    await facade.addPorts('hma:NL-AMS', 1);
    expect((await facade.listServers('hma:NL-AMS')).map((s) => [s.server, s.heldBy])).toEqual([
      ['10.0.0.1', 'x'],
      ['10.0.0.2', undefined],
      ['10.0.0.3', undefined],
    ]);
    expect(await facade.listServers('hma:NOPE')).toEqual([]);
    const spy = vi.spyOn(portManager, 'listServers');
    await facade.listServers('hma:NL-AMS', 'hma:NL-AMS#1');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ key: 'hma:NL-AMS' }), 'hma:NL-AMS#1');
    const targets = await facade.listTargets('hma');
    expect(targets.map((t) => [t.key, t.freeServers])).toEqual([
      ['hma:NL-AMS', 2],
      ['hma:JP-TYO', 1],
    ]);
    expect(targets.some((t) => 'notInPlan' in t)).toBe(false);
  });

  it('listTargets flags a location whose every server refused every account as not in the plan', async () => {
    const { facade } = setup({}, { '*': ['10.0.0.1'] });
    await facade.connectHma();
    const targets = await facade.listTargets('hma');
    expect(targets.map((t) => [t.key, t.notInPlan])).toEqual([
      ['hma:NL-AMS', undefined],
      ['hma:JP-TYO', true],
    ]);
  });

  it('startPorts: a file target is bound to its own imported file, never pooled', async () => {
    const { facade, state } = setup();
    await facade.importConfigFile('a.conf', 'x', 'VN');
    const b = await facade.importConfigFile('b.conf', 'y', 'VN');
    await facade.addPorts(`file:${b.account!.id}`, 1);
    expect(state.getState().ports[0].accountId).toBe(b.account!.id);
  });

  it('startPorts respects the provider limit', async () => {
    const { facade, state, queue } = setup();
    await facade.connectHma();
    await facade.setLimit('hma', 1);
    await facade.startPorts(['hma:NL-AMS', 'hma:JP-TYO']);
    expect(state.getState().ports.map((r) => r.key)).toEqual(['hma:NL-AMS#1']);
    expect(queue.enqueued).toEqual(['hma:NL-AMS#1']);
    expect((await facade.listProviders())[0].limit).toBe(1);
  });

  it('startPorts on a failed(port-in-use) row moves it to a fresh port ("Move to another port")', async () => {
    const { facade, state, allocated } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    state.setState((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p, state: { kind: 'failed', reason: 'port-in-use', untilMs: 0, attempt: 1 } })) }));
    await facade.startPorts(['hma:NL-AMS#1']);
    expect(allocated).toEqual([29002]);
    expect(state.getState().ports[0]).toMatchObject({ proxyPort: 29002, state: { kind: 'queued' } });
  });

  it('stopPorts / removePorts go through the port manager', async () => {
    const { facade, portManager, state } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    await facade.stopPorts(['hma:NL-AMS#1']);
    await facade.removePorts(['hma:NL-AMS#1']);
    expect(portManager.calls).toEqual(['stop:hma:NL-AMS#1', 'remove:hma:NL-AMS#1']);
    expect(state.getState().ports).toEqual([]);
  });

  it('removeAccount removes that account\'s ports and its secret', async () => {
    const { facade, state, secrets } = setup();
    const { account } = await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    await facade.removeAccount(account!.id);
    expect(state.getState().accounts).toEqual([]);
    expect(state.getState().ports).toEqual([]);
    expect(secrets.loadSecret(account!.secretRef)).toBeNull();
  });

  it('rotatePort maps port-manager note keys to renderer i18n keys', async () => {
    const { facade, portManager } = setup();
    portManager.setRotate({ changed: false, noteKey: 'rotated-to-another-city', movedTo: 'Rotterdam' });
    expect(await facade.rotatePort('k')).toEqual({ changed: false, noteKey: 'main.rotateResult.sameCityNote', movedTo: 'Rotterdam' });
    portManager.setRotate({ changed: false, noteKey: 'no-server' });
    expect((await facade.rotatePort('k')).noteKey).toBe('main.rotateResult.unchangedNote');
    portManager.setRotate({ changed: false, noteKey: 'server-unavailable' });
    expect((await facade.rotatePort('k#1', '10.0.0.2')).noteKey).toBe('main.rotateResult.serverTaken');
    expect(portManager.calls).toContain('rotate:k#1>10.0.0.2');
    expect(rotateNoteKey('online-timeout')).toBe('rotate.online-timeout');
    expect(rotateNoteKey(undefined)).toBeUndefined();
  });

  it('testPort runs the speed test only when asked, through the port with proxy auth', async () => {
    const { facade, speedTest, state } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    expect(await facade.testPort('hma:NL-AMS#1', false)).toEqual({ ok: true, exitIp: '9.9.9.9', latencyMs: 12 });
    expect(speedTest).not.toHaveBeenCalled();
    expect(await facade.testPort('hma:NL-AMS#1', true)).toMatchObject({ ok: true, mbps: 42.5 });
    const { proxyUser, proxyPass } = state.getState().settings;
    expect(speedTest).toHaveBeenCalledWith(29001, { username: proxyUser, password: proxyPass });
  });

  it('setSettings rejects an invalid patch and only reports accepted changes', async () => {
    const { facade, onSettingsChanged } = setup();
    await expect(facade.setSettings({ lanSharing: true, proxyUser: '' })).rejects.toThrow('settings.lanSharingRequiresAuth');
    expect(onSettingsChanged).not.toHaveBeenCalled();
    const next = await facade.setSettings({ basePort: 30001 });
    expect(next.basePort).toBe(30001);
    expect((await facade.getSettings()).basePort).toBe(30001);
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('getDiagnostics reports versions and per-provider counts, and nothing identifying', async () => {
    const { facade, state, secrets } = setup();
    await facade.connectHma();
    await facade.addAccount('zoogvpn', { email: 'someone@example.com', password: 'zoog-secret-pw' });
    const base = { providerId: 'hma' as const, accountId: 'hma-1', label: 'Amsterdam', country: 'NL', city: 'Amsterdam', enabled: true, autoRotateMin: 0 };
    state.setState((s) => ({
      ...s,
      settings: { ...s.settings, proxyUser: 'proxy-user-x', proxyPass: 'proxy-pass-x', webhook: { enabled: true, port: 29000, bearer: 'bearer-token-x'.repeat(3) } },
      ports: [
        { ...base, key: 'hma:NL-AMS#1', locationKey: 'hma:NL-AMS', server: '10.0.0.1', serverIp: '10.0.0.1', proxyPort: 29001, state: { kind: 'online', since: 1, exitIp: '198.51.100.7', country: 'NL' } },
        { ...base, key: 'hma:NL-AMS#2', locationKey: 'hma:NL-AMS', server: '10.0.0.2', serverIp: '10.0.0.2', proxyPort: 29002, state: { kind: 'online', since: 1, exitIp: '198.51.100.8', country: 'NL' } },
        { ...base, key: 'hma:NL-AMS#3', locationKey: 'hma:NL-AMS', server: '10.0.0.3', proxyPort: 29003, state: { kind: 'failed', reason: 'auth', untilMs: 1, attempt: 2 } },
        { ...base, key: 'zoogvpn:nl1#1', locationKey: 'zoogvpn:nl1', providerId: 'zoogvpn', accountId: 'zoogvpn-1', server: 'nl1.webunlim.com', serverIp: '203.0.113.9', proxyPort: 29004, state: { kind: 'stopped' }, enabled: false },
      ],
    }));

    const d = await facade.getDiagnostics();
    expect(d.appVersion).toBe('1.2.3');
    expect(d.singBox).toBe('1.14.2');
    expect(d.providers).toEqual([
      { id: 'hma', accounts: 1, ports: 3, portStates: { online: 2, failed: 1 } },
      { id: 'zoogvpn', accounts: 1, ports: 1, portStates: { stopped: 1 } },
      { id: 'surfshark', accounts: 0, ports: 0, portStates: {} },
      { id: 'nordvpn', accounts: 0, ports: 0, portStates: {} },
      { id: 'expressvpn', accounts: 0, ports: 0, portStates: {} },
      { id: 'file', accounts: 0, ports: 0, portStates: {} },
    ]);

    const json = JSON.stringify(d);
    const forbidden = [
      HMA_UDID, HMA_PASS, '000000000000', 'someone@example.com', 'zoog-secret-pw', 'proxy-user-x', 'proxy-pass-x', 'bearer-token-x',
      '198.51.100', '10.0.0.', '203.0.113.9', 'webunlim', '29001', 'hma-1', 'account:',
      ...[...secrets.map.values()],
    ];
    for (const s of forbidden) expect(json, `diagnostics must not contain ${s}`).not.toContain(s);
  });

  it('passes getLogs / getHostVpnActive / getAppStatus through', async () => {
    const { facade } = setup();
    expect(await facade.getLogs('k')).toEqual(['log for k']);
    expect(await facade.getHostVpnActive()).toBe(true);
    expect(await facade.getAppStatus()).toEqual({ secretsUnavailable: true });
  });

  it('getUpdateStatus / checkForUpdate / downloadAndInstallUpdate delegate to the updater service', async () => {
    const { facade, updater } = setup();
    // getUpdateStatus must NOT trigger a check — it returns the last-known status so the
    // renderer can seed its UI on mount without missing a startup-time result.
    expect(await facade.getUpdateStatus()).toEqual({ phase: 'available', currentVersion: '1.2.3', availableVersion: '2.0.0' });
    expect(updater.getStatus).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(await facade.checkForUpdate()).toEqual({ phase: 'up-to-date', currentVersion: '1.2.3' });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(await facade.downloadAndInstallUpdate()).toEqual({ success: true });
    expect(updater.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it('guessCountry takes the first 2-letter token of the file name', () => {
    expect(guessCountry('mullvad-se-got.conf')).toBe('SE');
    expect(guessCountry('us-nyc.ovpn')).toBe('US');
    expect(guessCountry('home.conf')).toBe('');
  });
});
