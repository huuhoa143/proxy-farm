import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { getProxyFarmApi, createFakeProxyFarmApi } from './api';

describe('getProxyFarmApi', () => {
  const original = (globalThis as { window?: { proxyFarm?: unknown } }).window?.proxyFarm;

  afterEach(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { proxyFarm?: unknown }).proxyFarm = original;
    }
  });

  it('returns window.proxyFarm when present', () => {
    const marker = { listProviders: async () => [] } as unknown as Window['proxyFarm'];
    (window as unknown as { proxyFarm?: unknown }).proxyFarm = marker;
    expect(getProxyFarmApi()).toBe(marker);
  });

  it('falls back to an in-memory fake when window.proxyFarm is absent', () => {
    (window as unknown as { proxyFarm?: unknown }).proxyFarm = undefined;
    const api = getProxyFarmApi();
    expect(api).toBeTruthy();
    expect(typeof api.listProviders).toBe('function');
  });
});

describe('createFakeProxyFarmApi', () => {
  let api: ReturnType<typeof createFakeProxyFarmApi>;

  beforeEach(() => {
    api = createFakeProxyFarmApi();
  });

  it('ships sample providers, including a detected HMA and an existing ZoogVPN account', async () => {
    const providers = await api.listProviders();
    const hma = providers.find((p) => p.id === 'hma');
    const zoog = providers.find((p) => p.id === 'zoogvpn');
    expect(hma?.detected?.found).toBe(true);
    expect(zoog?.accounts.length).toBeGreaterThan(0);
  });

  it('ships sample targets across providers', async () => {
    const targets = await api.listTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets.map((t) => t.providerId)).size).toBeGreaterThan(1);
  });

  it('ships sample ports with varied states', async () => {
    const ports = await api.listPorts();
    const kinds = new Set(ports.map((p) => p.state.kind));
    expect(ports.length).toBeGreaterThan(0);
    expect(kinds.has('online')).toBe(true);
  });

  it('startPorts transitions queued ports towards online and notifies subscribers', async () => {
    const before = await api.listPorts();
    const target = before.find((p) => p.state.kind === 'stopped');
    expect(target).toBeTruthy();

    let latest: Awaited<ReturnType<typeof api.listPorts>> = [];
    const unsubscribe = api.onPortsChanged((rows) => {
      latest = rows;
    });

    await api.startPorts([target!.key]);
    const row = latest.find((p) => p.key === target!.key);
    expect(row).toBeTruthy();
    expect(row!.state.kind).not.toBe('stopped');

    unsubscribe();
  });

  it('stopPorts marks ports stopped', async () => {
    const before = await api.listPorts();
    const online = before.find((p) => p.state.kind === 'online');
    expect(online).toBeTruthy();
    await api.stopPorts([online!.key]);
    const after = await api.listPorts();
    expect(after.find((p) => p.key === online!.key)?.state.kind).toBe('stopped');
  });

  it('rotatePort reports a changed exit on an online port', async () => {
    const before = await api.listPorts();
    const online = before.find((p) => p.state.kind === 'online');
    expect(online).toBeTruthy();
    const result = await api.rotatePort(online!.key);
    expect(result.changed).toBe(true);
  });

  it('getHostVpnActive defaults to false and onHostVpnChanged can be toggled for tests', async () => {
    expect(await api.getHostVpnActive()).toBe(false);
    let seen: boolean | undefined;
    api.onHostVpnChanged((active) => {
      seen = active;
    });
    api.__setHostVpnActive(true);
    expect(seen).toBe(true);
    expect(await api.getHostVpnActive()).toBe(true);
  });

  it('getSettings/setSettings round-trip', async () => {
    const settings = await api.getSettings();
    expect(settings.basePort).toBeGreaterThan(0);
    const patched = await api.setSettings({ lanSharing: true });
    expect(patched.lanSharing).toBe(true);
    expect((await api.getSettings()).lanSharing).toBe(true);
  });

  it('exportPorts renders each format', async () => {
    const ports = await api.listPorts();
    const key = ports[0].key;
    const hostPortUserPass = await api.exportPorts([key], 'hostPortUserPass');
    const socks5Url = await api.exportPorts([key], 'socks5Url');
    const hostPort = await api.exportPorts([key], 'hostPort');
    const curl = await api.exportPorts([key], 'curl');
    expect(hostPortUserPass).toContain(':');
    expect(socks5Url.startsWith('socks5://')).toBe(true);
    expect(hostPort.split(':').length).toBe(2);
    expect(curl).toContain('curl');
  });

  it('addAccount validates input via the matching provider and stores a new account on success', async () => {
    const ok = await api.addAccount('zoogvpn', { email: 'a@b.com', password: 'secret123' });
    expect(ok.ok).toBe(true);
    expect(ok.account?.providerId).toBe('zoogvpn');

    const bad = await api.addAccount('zoogvpn', { email: '', password: '' });
    expect(bad.ok).toBe(false);
  });

  it('connectHma succeeds when the fake HMA install is marked detected', async () => {
    const result = await api.connectHma();
    expect(result.ok).toBe(true);
    expect(result.account?.providerId).toBe('hma');
  });

  it('importConfigFile accepts a minimal wireguard conf', async () => {
    const content = ['[Interface]', 'PrivateKey = abc', '[Peer]', 'PublicKey = def', 'Endpoint = 1.2.3.4:51820'].join(
      '\n',
    );
    const result = await api.importConfigFile('sample.conf', content);
    expect(result.ok).toBe(true);
  });

  it('importConfigFile stores the (optionally edited) country on the account meta', async () => {
    const content = '[Interface]\nPrivateKey = abc\n[Peer]\nPublicKey = def\nEndpoint = 1.2.3.4:51820';
    const result = await api.importConfigFile('mullvad-se-got.conf', content, 'SE');
    expect(result.ok).toBe(true);
    expect(result.account?.meta.country).toBe('SE');
  });

  it('enableHmaSupport reports success (spec §7 elevated helper installer)', async () => {
    const result = await api.enableHmaSupport();
    expect(result.ok).toBe(true);
  });

  it('rotatePort moves to another city in the same country when the location has no free server (§6.5 step 2)', async () => {
    const result = await api.rotatePort('hma:US-NYC#1');
    expect(result.changed).toBe(true);
    expect(result.to).toBe('203.0.113.21');
    expect(result.noteKey).toBe('main.rotateResult.sameCityNote');
    const ports = await api.listPorts();
    expect(ports.find((p) => p.key === 'hma:US-NYC#1')).toBeUndefined();
    const moved = ports.find((p) => p.key === 'hma:US-LA#1');
    expect(moved?.city).toBe('Los Angeles');
    expect(moved?.locationKey).toBe('hma:US-LA');
  });

  it('rotatePort reports no server available when there is truly no alternative (§6.5 step 3)', async () => {
    const result = await api.rotatePort('zoogvpn:NL-AMS#1');
    expect(result.changed).toBe(false);
    expect(result.noteKey).toBe('main.rotateResult.unchangedNote');
  });

  it('getLogs returns fresh content on every call so a Refresh action is observable', async () => {
    const first = await api.getLogs('hma:JP-TOKYO#1');
    const second = await api.getLogs('hma:JP-TOKYO#1');
    expect(first[0]).not.toBe(second[0]);
  });

  it('setLimit accepts a per-provider limit without throwing', async () => {
    await expect(api.setLimit('hma', 5)).resolves.toBeUndefined();
  });
});

describe('fake server pools (spec §6.8)', () => {
  let api: ReturnType<typeof createFakeProxyFarmApi>;

  beforeEach(() => {
    api = createFakeProxyFarmApi();
  });

  it('keys ports `<location>#<n>` and pins each to a distinct server', async () => {
    const ports = await api.listPorts();
    const tokyo = ports.filter((p) => p.locationKey === 'hma:JP-TOKYO');
    expect(tokyo.map((p) => p.key).sort()).toEqual(['hma:JP-TOKYO#1', 'hma:JP-TOKYO#2']);
    expect(new Set(tokyo.map((p) => p.server)).size).toBe(2);
  });

  it('listTargets fills freeServers: usable and not held', async () => {
    const tokyo = (await api.listTargets()).find((t) => t.key === 'hma:JP-TOKYO')!;
    // 6 servers − 2 held − 1 refused − 1 dead.
    expect(tokyo.servers).toHaveLength(6);
    expect(tokyo.freeServers).toBe(2);
  });

  it('listServers reports health and which port holds each server', async () => {
    const servers = await api.listServers('hma:JP-TOKYO');
    const by = Object.fromEntries(servers.map((s) => [s.server, s]));
    expect(by['203.0.113.10'].heldBy).toBe('hma:JP-TOKYO#1');
    expect(by['203.0.113.13'].health).toBe('refused');
    expect(by['203.0.113.14'].health).toBe('dead');
    expect(by['203.0.113.12'].heldBy).toBeUndefined();
  });

  it('addPorts takes the smallest free n and a free server, and says when it ran out', async () => {
    const result = await api.addPorts('hma:JP-TOKYO', 5);
    expect(result.added.map((p) => p.key)).toEqual(['hma:JP-TOKYO#3', 'hma:JP-TOKYO#4']);
    expect(result.noteKey).toBe('no-free-server');
    const servers = new Set((await api.listPorts()).filter((p) => p.locationKey === 'hma:JP-TOKYO').map((p) => p.server));
    expect(servers.size).toBe(4);
    expect((await api.listTargets()).find((t) => t.key === 'hma:JP-TOKYO')?.freeServers).toBe(0);
  });

  it('addPorts reuses a freed port number', async () => {
    await api.removePorts(['hma:JP-TOKYO#1']);
    const result = await api.addPorts('hma:JP-TOKYO', 1);
    expect(result.added[0].key).toBe('hma:JP-TOKYO#1');
  });

  it("addPorts stops at the provider's port limit", async () => {
    await api.setLimit('hma', 3); // 2 Tokyo ports + 1 New York are enabled already
    const result = await api.addPorts('hma:SG-SIN', 2);
    expect(result.added).toHaveLength(0);
    expect(result.noteKey).toBe('limit-reached');
  });

  it('rotatePort(toServer) moves the port to the chosen free server', async () => {
    const result = await api.rotatePort('hma:JP-TOKYO#1', '203.0.113.15');
    expect(result).toMatchObject({ changed: true, from: '203.0.113.10', to: '203.0.113.15' });
    const row = (await api.listPorts()).find((p) => p.key === 'hma:JP-TOKYO#1')!;
    expect(row.server).toBe('203.0.113.15');
    expect(row.state.kind === 'online' && row.state.exitIp).toBe('203.0.113.15');
  });

  it('rotatePort(toServer) refuses a held, refused or dead server', async () => {
    for (const server of ['203.0.113.11', '203.0.113.13', '203.0.113.14']) {
      const result = await api.rotatePort('hma:JP-TOKYO#1', server);
      expect(result).toMatchObject({ changed: false, noteKey: 'main.rotateResult.serverTaken' });
    }
  });

  it('a bare location key in startPorts adds one port to that location', async () => {
    await api.startPorts(['hma:SG-SIN']);
    expect((await api.listPorts()).some((p) => p.key === 'hma:SG-SIN#1')).toBe(true);
  });
});
