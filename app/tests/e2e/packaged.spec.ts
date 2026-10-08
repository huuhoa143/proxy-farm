/**
 * Packaged-app E2E (spec §10): onboarding → import a WireGuard .conf → start → curl
 * through the port → test/speed → rotate → stop → quit leaves no engine → crash
 * (kill -9) → relaunch reaps the orphan.
 *
 * Everything runs against LOCAL WireGuard peers (a second sing-box on 127.0.0.1); no
 * HMA / ZoogVPN / Surfshark server is ever contacted. HMA is only *detected* (the
 * world-readable tokenCoreSE.json is read, Connect is never clicked).
 *
 * Run: pnpm run package && pnpm run test:e2e
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DISCLAIMER_NOTICE_VERSION, type PortRow, type Settings } from '../../src/shared/contracts';
import { APP_ROOT, BUNDLED_SINGBOX, IS_WIN, launchPackagedApp, type RunningApp } from './helpers/packaged-app';
import { curlThrough, isAlive, singboxProcesses } from './helpers/procs';
import { lanAddress, startLocalWgPeer, type WgPeer } from './helpers/wg-peer';

const SHOTS = path.join(APP_ROOT, '..', 'docs', 'screenshots', 'v2');
const HMA_TOKEN = '/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json';
const WIN_HMA_DIR = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Privax', 'HMA VPN');

let userData: string;
let work: string;
let app: RunningApp;
let peers: WgPeer[] = [];

const ports = (page: Page) => page.evaluate(() => window.proxyFarm.listPorts());
const settings = (page: Page): Promise<Settings> => page.evaluate(() => window.proxyFarm.getSettings());

async function waitForPort(page: Page, pred: (rows: PortRow[]) => boolean, timeoutMs = 60_000): Promise<PortRow[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await ports(page);
    if (pred(rows)) return rows;
    if (Date.now() > until) throw new Error(`port state never matched; last: ${JSON.stringify(rows.map((r) => [r.key, r.state]))}`);
    await page.waitForTimeout(500);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `real-${name}.png`) });
}

test.describe.serial('packaged Proxy Farm', () => {
  test.beforeAll(async () => {
    expect(singboxProcesses(), 'no Proxy Farm engine may be running before the suite').toEqual([]);
    userData = mkdtempSync(path.join(tmpdir(), 'pf-e2e-userdata-'));
    work = mkdtempSync(path.join(tmpdir(), 'pf-e2e-wg-'));
    peers = [startLocalWgPeer(BUNDLED_SINGBOX, work, 51991), startLocalWgPeer(BUNDLED_SINGBOX, work, 51992, lanAddress())];
    app = await launchPackagedApp(userData);
    // A fresh profile starts in Vietnamese with the first-run notice up; this suite
    // drives the English UI. Both settings persist, so relaunches below stay English.
    await app.page.evaluate((v) => window.proxyFarm.setSettings({ language: 'en', acknowledgedDisclaimer: v }), DISCLAIMER_NOTICE_VERSION);
    await app.page.reload();
  });

  test.afterAll(async () => {
    await app?.quit().catch(() => undefined);
    for (const p of peers) p.stop();
    rmSync(userData, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('onboarding renders with the real API, and HMA is detected on this Mac', async () => {
    const { page } = app;
    await expect(page.getByTestId('onboarding')).toBeVisible();
    expect(await page.evaluate(() => typeof window.proxyFarm.getAppStatus)).toBe('function');
    const status = await page.evaluate(() => window.proxyFarm.getAppStatus());
    expect(status.engineError).toBeUndefined();
    const providers = await page.evaluate(() => window.proxyFarm.listProviders());
    const hma = providers.find((p) => p.id === 'hma')!;
    if (IS_WIN) {
      // Installed HMA is either found (HMA support on, or the app runs elevated) or offers
      // "Enable HMA support"; without HMA there is nothing to detect.
      if (existsSync(WIN_HMA_DIR)) expect(hma.detected?.found || hma.detected?.hintKey === 'hma.helperMissing').toBe(true);
      else expect(hma.detected?.found).toBe(false);
    } else {
      expect(hma.detected?.found).toBe(existsSync(HMA_TOKEN));
      if (existsSync(HMA_TOKEN)) await expect(page.getByTestId('hma-detected')).toBeVisible();
    }
    expect(providers.every((p) => p.limit === 0)).toBe(true);
    await shot(page, 'onboarding');
  });

  test('settings round-trip through the real store (UI + API)', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    const before = await settings(page);
    expect(before.proxyUser).toBe('proxy');
    expect(before.proxyPass.length).toBeGreaterThan(8);
    await page.evaluate(() => window.proxyFarm.setSettings({ giveUpAfter: 7, keepAwake: false }));
    await page.reload();
    await page.getByRole('button', { name: 'Settings' }).click();
    const after = await settings(page);
    expect(after).toMatchObject({ giveUpAfter: 7, keepAwake: false, proxyPass: before.proxyPass });
    // invalid patch is rejected by main, nothing persisted
    const rejected = await page.evaluate(() => window.proxyFarm.setSettings({ lanSharing: true, proxyUser: '' }).then(() => 'accepted', (e: Error) => e.message));
    expect(rejected).toContain('settings.lanSharingRequiresAuth');
    expect((await settings(page)).lanSharing).toBe(false);
    await page.evaluate(() => window.proxyFarm.setSettings({ keepAwake: true }));
    await shot(page, 'settings');
  });

  test('import a local WireGuard .conf through the file card, with a country override', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Providers' }).click();
    await page.getByTestId('file-dropzone').locator('input[type=file]').setInputFiles({
      name: 'local-peer-a.conf',
      mimeType: 'text/plain',
      buffer: Buffer.from(peers[0].conf),
    });
    await expect(page.getByTestId('file-pending')).toBeVisible();
    await page.locator('#file-country').fill('VN');
    await page.getByTestId('file-pending').getByRole('button', { name: 'Import' }).click();
    await expect(page.getByTestId('file-message')).toContainText('127.0.0.1:51991');
    // second peer (same country) is the rotate fallback target, imported via the API
    const b = await page.evaluate((conf) => window.proxyFarm.importConfigFile('local-peer-b.conf', conf, 'VN'), peers[1].conf);
    expect(b.ok).toBe(true);
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('main-screen')).toBeVisible();
  });

  // Port limits show once a provider is connected (the onboarding gates them).
  test('a port limit round-trips through listProviders (Ruling C)', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Providers' }).click();
    await page.getByLabel('Port limit — Config file').fill('3');
    await page.getByTestId('provider-limit-file').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('provider-limit-saved-file')).toBeVisible();
    const providers = await page.evaluate(() => window.proxyFarm.listProviders());
    expect(providers.find((p) => p.id === 'file')!.limit).toBe(3);
    await page.getByRole('button', { name: 'Ports', exact: true }).click();
    await expect(page.getByTestId('main-screen')).toBeVisible();
  });

  test('start a port from the picker; it goes online and curl through it with proxy auth gets 200', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Add locations' }).first().click();
    await expect(page.getByTestId('location-picker')).toBeVisible();
    await page.getByTestId('location-picker').getByText('local-peer-a').click();
    await page.getByRole('button', { name: 'Add 1 port' }).click();
    const rows = await waitForPort(page, (r) => r.length === 1 && r[0].state.kind === 'online');
    const row = rows[0];
    expect(row.key).toBe('file:file-1#1');
    expect(row.proxyPort).toBe(29001);
    const s = await settings(page);
    expect(curlThrough(row.proxyPort, s.proxyUser, s.proxyPass, 'https://www.gstatic.com/generate_204')).toBe('204');
    expect(curlThrough(row.proxyPort, s.proxyUser, s.proxyPass, 'https://api.ipify.org')).toBe('200');
    // and the proxy refuses a client without credentials
    expect(curlThrough(row.proxyPort, s.proxyUser, 'wrong', 'https://api.ipify.org')).not.toBe('200');
    expect(singboxProcesses()).toHaveLength(1);
    await expect(page.getByTestId('port-row-file:file-1#1')).toContainText('Online');
    await shot(page, 'main-online');
  });

  test('test + speed test through the port, and the Details drawer shows engine logs', async () => {
    const { page } = app;
    const result = await page.evaluate(() => window.proxyFarm.testPort('file:file-1#1', true));
    expect(result.ok).toBe(true);
    expect(result.exitIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(result.mbps).toBeGreaterThan(0);
    const logs = await page.evaluate(() => window.proxyFarm.getLogs('file:file-1#1'));
    expect(logs.join('\n')).toContain('sing-box started');
    expect(logs.join('\n')).not.toContain((await settings(page)).proxyPass);
    await page.getByTestId('port-row-file:file-1#1').getByRole('button', { name: 'Details' }).click();
    await expect(page.getByTestId('details-file:file-1#1')).toBeVisible();
    await shot(page, 'details');
    await page.keyboard.press('Escape');
  });

  test('export gives host:port:user:pass for the running port', async () => {
    const { page } = app;
    const s = await settings(page);
    const text = await page.evaluate(() => window.proxyFarm.exportPorts(['file:file-1#1'], 'hostPortUserPass'));
    expect(text.trim()).toBe(`127.0.0.1:29001:${s.proxyUser}:${s.proxyPass}`);
  });

  test('rotate moves the port onto the other server in the same country and it comes back online', async () => {
    const { page } = app;
    const before = singboxProcesses();
    const result = await page.evaluate(() => window.proxyFarm.rotatePort('file:file-1#1'));
    // Each file is a location with one server, so Change IP falls back to the other
    // location of the same country (§6.5). Both local peers exit through this computer's
    // own IP, so the exit IP cannot change — but the port must be re-bound and online.
    expect(result.noteKey).toBe('main.rotateResult.sameCityNote');
    const rows = await waitForPort(page, (r) => r[0]?.key === 'file:file-2#1' && r[0].state.kind === 'online');
    expect(rows[0].proxyPort).toBe(29001);
    const after = singboxProcesses();
    expect(after).toHaveLength(1);
    expect(after[0].pid).not.toBe(before[0].pid);
    const s = await settings(page);
    expect(curlThrough(29001, s.proxyUser, s.proxyPass, 'https://api.ipify.org')).toBe('200');
  });

  test('stop ends the engine and the port refuses connections', async () => {
    const { page } = app;
    await page.evaluate(() => window.proxyFarm.stopPorts(['file:file-2#1']));
    await waitForPort(page, (r) => r[0].state.kind === 'stopped' && !r[0].enabled);
    expect(singboxProcesses()).toEqual([]);
    const s = await settings(page);
    expect(curlThrough(29001, s.proxyUser, s.proxyPass, 'https://api.ipify.org')).toMatch(/^(ERR|000)/);
  });

  test('quitting leaves NO sing-box process', async () => {
    const { page } = app;
    await page.evaluate(() => window.proxyFarm.startPorts(['file:file-2#1']));
    await waitForPort(page, (r) => r[0].state.kind === 'online');
    expect(singboxProcesses()).toHaveLength(1);
    const code = await app.quit();
    expect(code).toBe(0);
    expect(singboxProcesses()).toEqual([]);
  });

  // Windows: Node puts every child in a kill-on-close job object, so an engine cannot
  // outlive a killed app there; the orphan reaping below is the macOS safety net.
  test('on Windows, killing the app outright also ends its engine, and the next launch restarts the port', async () => {
    test.skip(!IS_WIN, 'Windows only');
    app = await launchPackagedApp(userData);
    await waitForPort(app.page, (r) => r[0]?.state.kind === 'online');
    const [engine] = singboxProcesses();
    expect(engine).toBeDefined();

    process.kill(app.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 1500));
    expect(isAlive(app.pid)).toBe(false);
    expect(isAlive(engine.pid), 'the engine dies with its app').toBe(false);
    expect(singboxProcesses()).toEqual([]);

    app = await launchPackagedApp(userData);
    await waitForPort(app.page, (r) => r[0]?.state.kind === 'online');
    expect(singboxProcesses()).toHaveLength(1);
    expect(await app.quit()).toBe(0);
    expect(singboxProcesses()).toEqual([]);
  });

  test('relaunch restarts the port; kill -9 orphans its engine; the next launch reaps it', async () => {
    test.skip(IS_WIN, 'an engine cannot outlive its app on Windows (see above)');
    app = await launchPackagedApp(userData);
    await waitForPort(app.page, (r) => r[0]?.state.kind === 'online');
    const [orphan] = singboxProcesses();
    expect(orphan).toBeDefined();

    process.kill(app.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 1000));
    expect(isAlive(app.pid)).toBe(false);
    expect(isAlive(orphan.pid), 'the engine survives its parent being SIGKILLed').toBe(true);

    app = await launchPackagedApp(userData);
    await waitForPort(app.page, (r) => r[0]?.state.kind === 'online');
    expect(isAlive(orphan.pid), 'the orphaned engine was reaped at startup').toBe(false);
    expect(app.output()).toContain('reaped 1 orphaned engine process');
    const now = singboxProcesses();
    expect(now).toHaveLength(1);
    expect(now[0].pid).not.toBe(orphan.pid);

    expect(await app.quit()).toBe(0);
    expect(singboxProcesses()).toEqual([]);
  });
});
