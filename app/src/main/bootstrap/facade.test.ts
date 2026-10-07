import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PortRow, Provider, ProviderId, RotateResult, Target } from '../../shared/contracts';
import { createAccountPool } from '../accounts/pool';
import { createRefusalTracker } from '../accounts/refusals';
import type { PortManager } from '../controller/port-manager';
import type { StartQueue } from '../controller/start-queue';
import type { SecretStore } from '../store/secrets';
import { createStateStore, type StateStore } from '../store/state';
import { createControllerFacade, guessCountry, rotateNoteKey, type FacadeDeps } from './facade';
import type { HmaRead } from './hma-local';

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

function fakePortManager(state: StateStore) {
  const calls: string[] = [];
  let rotateResult: RotateResult = { changed: true, from: '1.1.1.1', to: '2.2.2.2' };
  const pm: PortManager & { calls: string[]; setRotate(r: RotateResult): void } = {
    calls,
    setRotate: (r) => (rotateResult = r),
    startPort: async (key) => void calls.push(`start:${key}`),
    stopPort: async (key) => {
      calls.push(`stop:${key}`);
      state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, enabled: false, state: { kind: 'stopped' } } : p)) }));
    },
    removePort: async (key) => {
      calls.push(`remove:${key}`);
      state.setState((s) => ({ ...s, ports: s.ports.filter((p) => p.key !== key) }));
    },
    rotatePort: async () => rotateResult,
    setAutoRotate: async () => undefined,
    exportPorts: async () => '',
    testPort: async () => ({ ok: true, exitIp: '9.9.9.9', latencyMs: 12 }),
    ensurePort: async (t, accountId) => {
      const used = new Set(state.getState().ports.map((p) => p.proxyPort));
      let proxyPort = 29001;
      while (used.has(proxyPort)) proxyPort += 1;
      const row: PortRow = { key: t.key, providerId: t.providerId, accountId, label: t.label, country: t.country, city: t.city, proxyPort, enabled: false, state: { kind: 'queued' }, autoRotateMin: 0 };
      state.setState((s) => ({ ...s, ports: [...s.ports, row] }));
      return row;
    },
    syncAutoRotate: () => undefined,
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

  function setup(overrides: Partial<FacadeDeps> = {}) {
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
      hma: fakeProvider('hma', () => [target('hma:NL-AMS'), target('hma:JP-TYO', 'JP')]),
      zoogvpn: fakeProvider('zoogvpn', () => [target('zoogvpn:nl1')]),
      file: fakeProvider('file', (a) => [{ ...target(`file:${a.id}`, a.meta.country), city: a.meta.city }]),
    };
    const portManager = fakePortManager(state);
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
      log: () => undefined,
      ...overrides,
    };
    return { facade: createControllerFacade(deps), state, secrets, portManager, queue, allocated, speedTest, onSettingsChanged, updater };
  }

  it('listProviders reports HMA detection and each provider limit (Ruling C)', async () => {
    const { facade, state } = setup();
    state.setState((s) => ({ ...s, limits: { ...s.limits, zoogvpn: 3 } }));
    const list = await facade.listProviders();
    expect(list.map((p) => p.id)).toEqual(['hma', 'zoogvpn', 'surfshark', 'file']);
    expect(list[0].detected).toEqual({ found: true });
    expect(list[1].limit).toBe(3);
    expect(list[2].limit).toBe(0);
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

  it('connectHma: not installed → hma.notFound; not macOS → hma.windowsLater', async () => {
    hmaRead = { status: 'missing' };
    expect(await setup().facade.connectHma()).toEqual({ ok: false, reasonKey: 'hma.notFound' });
    expect(await setup({ platform: 'win32' }).facade.connectHma()).toEqual({ ok: false, reasonKey: 'hma.windowsLater' });
  });

  it('enableHmaSupport is stubbed until the Windows track', async () => {
    expect(await setup().facade.enableHmaSupport()).toEqual({ ok: false, reasonKey: 'hma.windowsLater' });
  });

  it('addAccount(zoogvpn) maps the card\'s "email" field to the provider\'s username', async () => {
    const { facade, secrets } = setup();
    const r = await facade.addAccount('zoogvpn', { email: 'me@example.com', password: 'pw' });
    expect(r.ok).toBe(true);
    expect(JSON.parse(secrets.loadSecret(r.account!.secretRef)!)).toEqual({ kind: 'userpass', username: 'me@example.com', password: 'pw' });
    expect(await facade.addAccount('zoogvpn', { password: 'pw' })).toMatchObject({ ok: false, reasonKey: 'zoogvpn.check.missingUsername' });
  });

  it('importConfigFile honours the country override, else guesses it from the file name', async () => {
    const { facade } = setup();
    const a = await facade.importConfigFile('home.conf', '[Interface]', 'se');
    expect(a.account?.meta).toMatchObject({ country: 'SE', city: 'home' });
    const b = await facade.importConfigFile('mullvad-de-ber.conf', '[Interface]');
    expect(b.account?.meta.country).toBe('DE');
    expect(await facade.importConfigFile('x.txt', '')).toMatchObject({ ok: false, reasonKey: 'file.check.unknownExtension' });
  });

  it('startPorts: a new target gets an account from the pool, a port row, and goes through the queue', async () => {
    const { facade, state, queue } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS', 'hma:JP-TYO', 'hma:NOPE']);
    const rows = state.getState().ports;
    expect(rows.map((r) => [r.key, r.proxyPort, r.enabled, r.state.kind])).toEqual([
      ['hma:NL-AMS', 29001, true, 'queued'],
      ['hma:JP-TYO', 29002, true, 'queued'],
    ]);
    expect(rows[0].accountId).toBe('hma-1');
    expect(queue.enqueued).toEqual(['hma:NL-AMS', 'hma:JP-TYO']);
  });

  it('startPorts: a file target is bound to its own imported file, never pooled', async () => {
    const { facade, state } = setup();
    await facade.importConfigFile('a.conf', 'x', 'VN');
    const b = await facade.importConfigFile('b.conf', 'y', 'VN');
    await facade.startPorts([`file:${b.account!.id}`]);
    expect(state.getState().ports[0].accountId).toBe(b.account!.id);
  });

  it('startPorts respects the provider limit', async () => {
    const { facade, state, queue } = setup();
    await facade.connectHma();
    await facade.setLimit('hma', 1);
    await facade.startPorts(['hma:NL-AMS', 'hma:JP-TYO']);
    expect(state.getState().ports.map((r) => r.key)).toEqual(['hma:NL-AMS']);
    expect(queue.enqueued).toEqual(['hma:NL-AMS']);
    expect((await facade.listProviders())[0].limit).toBe(1);
  });

  it('startPorts on a failed(port-in-use) row moves it to a fresh port ("Move to another port")', async () => {
    const { facade, state, allocated } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    state.setState((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p, state: { kind: 'failed', reason: 'port-in-use', untilMs: 0, attempt: 1 } })) }));
    await facade.startPorts(['hma:NL-AMS']);
    expect(allocated).toEqual([29002]);
    expect(state.getState().ports[0]).toMatchObject({ proxyPort: 29002, state: { kind: 'queued' } });
  });

  it('stopPorts / removePorts go through the port manager', async () => {
    const { facade, portManager, state } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    await facade.stopPorts(['hma:NL-AMS']);
    await facade.removePorts(['hma:NL-AMS']);
    expect(portManager.calls).toEqual(['stop:hma:NL-AMS', 'remove:hma:NL-AMS']);
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
    portManager.setRotate({ changed: true, noteKey: 'rotated-to-another-city' });
    expect((await facade.rotatePort('k')).noteKey).toBe('main.rotateResult.sameCityNote');
    portManager.setRotate({ changed: false, noteKey: 'no-server' });
    expect((await facade.rotatePort('k')).noteKey).toBe('main.rotateResult.unchangedNote');
    expect(rotateNoteKey('online-timeout')).toBe('rotate.online-timeout');
    expect(rotateNoteKey(undefined)).toBeUndefined();
  });

  it('testPort runs the speed test only when asked, through the port with proxy auth', async () => {
    const { facade, speedTest, state } = setup();
    await facade.connectHma();
    await facade.startPorts(['hma:NL-AMS']);
    expect(await facade.testPort('hma:NL-AMS', false)).toEqual({ ok: true, exitIp: '9.9.9.9', latencyMs: 12 });
    expect(speedTest).not.toHaveBeenCalled();
    expect(await facade.testPort('hma:NL-AMS', true)).toMatchObject({ ok: true, mbps: 42.5 });
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
