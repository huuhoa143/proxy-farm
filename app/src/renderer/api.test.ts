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

  it('rotatePort moves to another city in the same country when the location has no other IP (§6.5 step 2)', async () => {
    await api.startPorts(['hma:US-NYC']);
    const result = await api.rotatePort('hma:US-NYC');
    expect(result.changed).toBe(true);
    expect(result.to).toBe('203.0.113.21');
    expect(result.noteKey).toBe('main.rotateResult.sameCityNote');
    const row = (await api.listPorts()).find((p) => p.key === 'hma:US-NYC');
    expect(row?.city).toBe('Los Angeles');
  });

  it('rotatePort reports no server available when there is truly no alternative (§6.5 step 3)', async () => {
    await api.startPorts(['zoogvpn:NL-AMS']);
    const result = await api.rotatePort('zoogvpn:NL-AMS');
    expect(result.changed).toBe(false);
    expect(result.noteKey).toBe('main.rotateResult.unchangedNote');
  });

  it('getLogs returns fresh content on every call so a Refresh action is observable', async () => {
    const first = await api.getLogs('hma:JP-TOKYO');
    const second = await api.getLogs('hma:JP-TOKYO');
    expect(first[0]).not.toBe(second[0]);
  });

  it('setLimit accepts a per-provider limit without throwing', async () => {
    await expect(api.setLimit('hma', 5)).resolves.toBeUndefined();
  });
});
