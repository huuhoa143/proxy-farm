/**
 * Live NordVPN E2E against the PACKAGED app and Nord's real servers — a maintainer run,
 * skipped unless PF_NORD_TOKEN holds a Nord Account access token (never hardcoded,
 * never written anywhere by this suite). Drives the UI the way a user does:
 *
 *   NordVPN card (token → NordLynx key) → Add locations → 2 ports in one city →
 *   both online on different servers, Nord's recommendation first → curl through each →
 *   Change IP (next free server, then a picked server) → a virtual location (Hanoi) →
 *   stop / remove → quit leaves no engine of this build.
 *
 * Isolated profile (PROXYFARM_USER_DATA_DIR); engines are counted by this build's
 * sing-box path only, so another Proxy Farm running on the machine is not disturbed.
 *
 * Run: pnpm run package && PF_NORD_TOKEN=… pnpm exec playwright test -c tests/e2e/playwright.config.ts nordvpn-live
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DISCLAIMER_NOTICE_VERSION, type PortRow, type Settings, type Target } from '../../src/shared/contracts';
import { APP_BUNDLE, IS_WIN, launchPackagedApp, type RunningApp } from './helpers/packaged-app';
import { curlThrough } from './helpers/procs';

const TOKEN = process.env.PF_NORD_TOKEN?.trim() ?? '';
const CITY = process.env.PF_NORD_CITY ?? 'nordvpn:SG-SINGAPORE';
const VIRTUAL_CITY = 'nordvpn:VN-HANOI';

let userData: string;
let app: RunningApp;

const ports = (page: Page) => page.evaluate(() => window.proxyFarm.listPorts());
const settings = (page: Page): Promise<Settings> => page.evaluate(() => window.proxyFarm.getSettings());
const targets = (page: Page): Promise<Target[]> => page.evaluate(() => window.proxyFarm.listTargets('nordvpn'));

async function waitForPorts(page: Page, pred: (rows: PortRow[]) => boolean, what: string, timeoutMs = 120_000): Promise<PortRow[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await ports(page);
    if (pred(rows)) return rows;
    if (Date.now() > until) throw new Error(`${what}: never matched; last: ${JSON.stringify(rows.map((r) => [r.key, r.server, r.state]))}`);
    await page.waitForTimeout(1000);
  }
}

const online = (r: PortRow) => r.state.kind === 'online';
const exitOf = (r: PortRow) => (r.state.kind === 'online' ? r.state.exitIp : undefined);

/** sing-box engines started from THIS packaged build (path-filtered). */
function ourEngines(): number[] {
  if (!IS_WIN) throw new Error('this suite is written for Windows');
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"name='sing-box.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"],
    { encoding: 'utf8' },
  );
  return out
    .split(/\r?\n/)
    .filter((l) => l.includes('|') && l.toLowerCase().includes(APP_BUNDLE.toLowerCase()))
    .map((l) => Number(l.split('|')[0]));
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

test.describe.serial('NordVPN, live', () => {
  test.skip(!TOKEN, 'set PF_NORD_TOKEN to a Nord Account access token');

  test.beforeAll(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'pf-e2e-nord-'));
    app = await launchPackagedApp(userData);
    app.page.on('crash', () => console.log('[renderer crash]', new Date().toISOString()));
    app.page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await app.page.evaluate((v) => window.proxyFarm.setSettings({ language: 'en', acknowledgedDisclaimer: v }), DISCLAIMER_NOTICE_VERSION);
    await app.page.reload();
  });

  test.afterAll(async () => {
    if (app) {
      const keys = (await ports(app.page).catch(() => [])).map((r) => r.key);
      if (keys.length) await app.page.evaluate((k) => window.proxyFarm.removePorts(k), keys).catch(() => undefined);
      await app.quit().catch(() => undefined);
    }
    if (userData) rmSync(userData, { recursive: true, force: true });
  });

  test('the NordVPN card is in the UI and adds the account from an access token; the token is not kept', async () => {
    const { page } = app;
    await expect(page.getByTestId('onboarding')).toBeVisible();
    const providers = await page.evaluate(() => window.proxyFarm.listProviders());
    expect(providers.map((p) => p.id)).toContain('nordvpn');
    await page.locator('#nordvpn-credential').fill(TOKEN);
    await page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await expect(page.getByTestId('nordvpn-message')).toBeVisible({ timeout: 30_000 });
    const nord = (await page.evaluate(() => window.proxyFarm.listProviders())).find((p) => p.id === 'nordvpn')!.accounts;
    expect(nord, await page.getByTestId('nordvpn-message').innerText()).toHaveLength(1);
    expect(nord[0].label).toMatch(/…/); // labelled by the PUBLIC key's end
    // The token appears in no file of the profile (state, secrets, cache).
    // Chromium holds a few of its own files locked; the app's files must all be readable.
    let appFiles = 0;
    for (const f of filesUnder(userData)) {
      const ours = /[\\/](state\.json|secrets[\\/].*|cache[\\/].*)$/.test(f);
      let bytes: Buffer;
      try {
        if (statSync(f).size > 50_000_000) continue;
        bytes = readFileSync(f);
      } catch (err) {
        if (ours) throw err;
        continue;
      }
      if (ours) appFiles++;
      expect(bytes.includes(Buffer.from(TOKEN)), `token found in ${f}`).toBe(false);
    }
    expect(appFiles).toBeGreaterThanOrEqual(2); // state.json + the account's secret, at least
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('main-screen')).toBeVisible();
  });

  test('locations: the standard-group list, no Dedicated IP / Double VPN servers', async () => {
    const { page } = app;
    const list = await targets(page);
    expect(list.length).toBeGreaterThan(150);
    const total = list.reduce((n, t) => n + t.servers.length, 0);
    // ≈ 5300 standard servers vs ≈ 7000 NordLynx servers in all groups (2026-10-24)
    expect(total).toBeGreaterThan(3000);
    expect(total).toBeLessThan(6600);
    const cache = JSON.parse(readFileSync(path.join(userData, 'cache', 'nordvpn-servers.json'), 'utf8'));
    expect(cache.version).toBe(2);
    expect(list.find((t) => t.key === CITY), `${CITY} is listed`).toBeTruthy();
  });

  test('Add locations → 2 ports in one city: both online, on different servers, curl works through each', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Add locations' }).first().click();
    await expect(page.getByTestId('location-picker')).toBeVisible();
    await page.getByPlaceholder('Search country or city').fill(CITY.split('-').slice(1).join(' ').toLowerCase());
    const row = page.getByTestId(`pick-${CITY}`);
    await expect(row).toBeVisible();
    // Ticking the city shows its stepper at 1 port; + makes it 2.
    await row.locator('input.ck').check();
    await row.getByRole('button', { name: /^One more port in/ }).click();
    await expect(row.getByRole('spinbutton')).toHaveValue('2');
    await page.getByTestId('picker-submit').click();
    const rows = await waitForPorts(page, (r) => r.filter((p) => p.locationKey === CITY && online(p)).length === 2, 'two ports online');
    const mine = rows.filter((p) => p.locationKey === CITY);
    expect(new Set(mine.map((p) => p.server)).size).toBe(2);
    const s = await settings(page);
    for (const p of mine) {
      expect(curlThrough(p.proxyPort, s.proxyUser, s.proxyPass, 'https://www.gstatic.com/generate_204'), p.key).toBe('204');
      const test1 = await page.evaluate((k) => window.proxyFarm.testPort(k, false), p.key);
      expect(test1.ok, JSON.stringify(test1)).toBe(true);
      expect(test1.exitIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
    expect(ourEngines()).toHaveLength(2);
    // Nord's recommendation reordered the city: the cached order is no longer plain
    // least-loaded, and both picks are among its first servers.
    const cache = JSON.parse(readFileSync(path.join(userData, 'cache', 'nordvpn-servers.json'), 'utf8'));
    const city = cache.locations.find((l: { key: string }) => l.key === CITY);
    const order: Array<{ ip: string; load: number }> = city.servers;
    const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
    const plain = [...order].sort((a, b) => a.load - b.load || ipNum(a.ip) - ipNum(b.ip));
    const recommendedApplied = order.some((sv, i) => sv.ip !== plain[i].ip);
    if (order.length > 2) expect(recommendedApplied, 'recommendations reordered the city').toBe(true);
    const head = new Set(order.slice(0, 30).map((sv) => sv.ip));
    for (const p of mine) expect(head.has(p.server!), `${p.server} is a recommended server`).toBe(true);
    await expect(page.getByTestId(`port-row-${mine[0].key}`)).toContainText('Online');
  });

  test('Change IP (UI, next free server) moves the port to another server and it comes back online', async () => {
    const { page } = app;
    const [before] = (await ports(page)).filter((p) => p.locationKey === CITY);
    const others = new Set((await ports(page)).filter((p) => p.key !== before.key).map((p) => p.server));
    await page.getByTestId(`change-ip-${before.key}`).click();
    const menu = page.getByTestId('change-ip-menu');
    if (await menu.isVisible().catch(() => false)) await menu.getByText('Next free server').click();
    const [after] = await waitForPorts(
      page,
      (r) => r.some((p) => p.key === before.key && online(p) && p.server !== before.server),
      'rotated port online',
    ).then((r) => r.filter((p) => p.key === before.key));
    expect(after.server).not.toBe(before.server);
    expect(others.has(after.server), 'never onto a server another port holds').toBe(false);
    expect(after.proxyPort).toBe(before.proxyPort); // the port number stays
    const s = await settings(page);
    expect(curlThrough(after.proxyPort, s.proxyUser, s.proxyPass, 'https://www.gstatic.com/generate_204')).toBe('204');
    expect(ourEngines()).toHaveLength(2);
    console.log(`rotated ${before.key}: ${before.server} (${exitOf(before)}) → ${after.server} (${exitOf(after)})`);
  });

  test('Change IP to a server picked from the menu', async () => {
    const { page } = app;
    const [row] = (await ports(page)).filter((p) => p.locationKey === CITY);
    const servers = await page.evaluate(([loc, key]) => window.proxyFarm.listServers(loc, key), [CITY, row.key] as const);
    const free = servers.find((sv) => !sv.heldBy && sv.server !== row.server && sv.health !== 'refused' && sv.health !== 'dead');
    expect(free, 'a free server to pick').toBeTruthy();
    await page.getByTestId(`change-ip-${row.key}`).click();
    const menu = page.getByTestId('change-ip-menu');
    await expect(menu).toBeVisible();
    const pick = menu.getByTestId(`server-${free!.server}`);
    if (await pick.isVisible().catch(() => false)) await pick.click();
    else await page.evaluate(([k, sv]) => window.proxyFarm.rotatePort(k, sv), [row.key, free!.server] as const);
    const [after] = (await waitForPorts(page, (r) => r.some((p) => p.key === row.key && online(p) && p.server === free!.server), 'picked server online')).filter(
      (p) => p.key === row.key,
    );
    expect(after.server).toBe(free!.server);
  });

  test('a virtual location (Hanoi) adds, goes online and is marked virtual', async () => {
    const { page } = app;
    const hanoi = (await targets(page)).find((t) => t.key === VIRTUAL_CITY);
    test.skip(!hanoi, 'Hanoi not listed today');
    expect(hanoi!.virtualLocation).toBe(true);
    const added = await page.evaluate((k) => window.proxyFarm.addPorts(k, 1), VIRTUAL_CITY);
    expect(added.added).toHaveLength(1);
    const key = added.added[0].key;
    await waitForPorts(page, (r) => r.some((p) => p.key === key && online(p)), 'Hanoi online');
    await expect(page.getByTestId(`virtual-${VIRTUAL_CITY}`)).toBeVisible();
  });

  test('stop and remove: engines end; quitting leaves no engine of this build', async () => {
    const { page } = app;
    const keys = (await ports(page)).map((r) => r.key);
    await page.evaluate((k) => window.proxyFarm.stopPorts(k), keys);
    await waitForPorts(page, (r) => r.every((p) => p.state.kind === 'stopped'), 'all stopped', 30_000);
    expect(ourEngines()).toEqual([]);
    await page.evaluate((k) => window.proxyFarm.removePorts(k), keys);
    await waitForPorts(page, (r) => r.length === 0, 'all removed', 15_000);
    expect(await app.quit()).toBe(0);
    expect(ourEngines()).toEqual([]);
    expect(existsSync(path.join(userData, 'state.json'))).toBe(true);
  });
});
