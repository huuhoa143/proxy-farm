/* eslint-disable no-console */
// Headless end-to-end test of the REAL controller stack (facade + port-manager + real
// sing-box engine + se-platform backend) against live HMA. Exercises: add ports, multiple
// ports in one location (concurrent), Change IP, delete ports — the exact code paths the UI
// uses. License key comes from PF_HMA_LICENSE (never hardcoded). Temp state dir; engines
// stopped on exit. NOT a committed test — a maintainer E2E, run by hand.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStateStore } from '../src/main/store/state';
import { registerAllProviders, getProvider } from '../src/main/providers/index';
import { createRealEngine } from '../src/main/controller/engine-adapter';
import { createRealExitIpProber, createRealPortAllocator } from '../src/main/controller/real-bindings';
import { createPortManager } from '../src/main/controller/port-manager';
import { createAccountPool } from '../src/main/accounts/pool';
import { createRefusalTracker } from '../src/main/accounts/refusals';
import { createStartQueue } from '../src/main/controller/start-queue';
import { PortHealth } from '../src/main/health/state-machine';
import { createControllerFacade } from '../src/main/bootstrap/facade';
import { portLimitOf } from '../src/shared/contracts';

const LICENSE = process.env.PF_HMA_LICENSE;
if (!LICENSE) { console.error('set PF_HMA_LICENSE'); process.exit(2); }
const SB = path.join(process.cwd(), 'resources', 'sing-box', 'windows-amd64', 'sing-box.exe');
const dir = mkdtempSync(path.join(tmpdir(), 'pf-e2e-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c: boolean, msg: string) => { console.log(`  ${c ? '✅' : '❌'} ${msg}`); c ? pass++ : fail++; };

// In-memory secret store (no Electron safeStorage needed).
const mem = new Map<string, string>();
const secrets = { saveSecret: (id: string, v: string) => void mem.set(id, v), loadSecret: (id: string) => mem.get(id) ?? null, deleteSecret: (id: string) => void mem.delete(id) };
const walletKeyOf = (ref: string): string | undefined => { try { return JSON.parse(mem.get(ref) ?? '{}').walletKey; } catch { return undefined; } };

const state = createStateStore(path.join(dir, 'state.json'), secrets);
registerAllProviders({
  surfsharkCachePath: path.join(dir, 'cache', 'surfshark.json'),
  nordvpnCachePath: path.join(dir, 'cache', 'nordvpn.json'),
  expressvpnPoolPath: path.join(dir, 'cache', 'expressvpn.json'),
  onTargetsChanged: () => {},
  hmaLoadWalletKey: (a) => walletKeyOf(a.secretRef),
});
const engine = createRealEngine({ registryPath: path.join(dir, 'pids.json'), binPath: SB, createPortHealth: (o) => new PortHealth({ ...o }) });
const providers = { get: getProvider };
const refusals = createRefusalTracker({});
const pool = createAccountPool({
  listAccounts: () => state.getState().accounts,
  listPorts: () => state.getState().ports,
  setPortAccount: (key, accountId) => state.setState((s) => ({ ...s, ports: s.ports.map((p) => (p.key === key ? { ...p, accountId } : p)) })),
  getLimit: (id) => portLimitOf(state.getState().limits, id),
  isUsable: () => true,
  refusals,
});
const portManager = createPortManager({
  state, secrets, engine, providers, exitIp: createRealExitIpProber(), allocator: createRealPortAllocator(), refusals, pool,
  refreshDeviceCredentials: async (accountId) => {
    const account = state.getState().accounts.find((a) => a.id === accountId);
    const refreshed = account && (await getProvider('hma')?.refreshCredentials?.(account).catch(() => undefined));
    if (!account || !refreshed) return false;
    secrets.saveSecret(account.secretRef, JSON.stringify(refreshed.secret));
    if (refreshed.meta) state.setState((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, meta: { ...a.meta, ...refreshed.meta } } : a)) }));
    return true;
  },
});
const queue = createStartQueue({ onTaskError: (k, e) => console.log('start error', k, (e as Error)?.message) });
const stub: any = () => undefined;
const facade = createControllerFacade({
  state, secrets, providers, portManager, pool, queue, allocator: createRealPortAllocator(),
  engineLogs: (k) => engine.getLogs(k), hostVpn: { start: stub, stop: stub, onChange: () => stub } as any,
  platform: process.platform, speedTest: async () => 0, appStatus: () => ({} as any), updater: {} as any,
  saveExport: async () => ({} as any), diagnosticsEnv: () => ({} as any), log: () => {},
});

const proxyOf = (key: string) => state.getState().ports.find((p) => p.key === key)?.proxyPort;
function exitIp(port?: number): string {
  if (!port) return '(no port)';
  const s = state.getState().settings;
  const args = ['-s', '--max-time', '15', '--socks5-hostname', `127.0.0.1:${port}`];
  if (s.proxyUser && s.proxyPass) args.push('-U', `${s.proxyUser}:${s.proxyPass}`);
  args.push('https://api.ipify.org');
  try { return execFileSync('curl', args, { encoding: 'utf8' }).trim() || '(empty)'; }
  catch (e) { return 'ERR:' + ((e as Error).message || '').slice(0, 30); }
}
async function waitOnline(keys: string[], secs = 60): Promise<void> {
  for (let i = 0; i < secs; i++) {
    const rows = state.getState().ports.filter((p) => keys.includes(p.key));
    if (rows.length === keys.length && rows.every((p) => p.state.kind === 'online')) return;
    await sleep(1000);
  }
}

async function main() {
  console.log('E2E dir:', dir);
  console.log('\n[1] connect HMA with license key');
  const added = await facade.addAccount('hma', { licenseKey: LICENSE });
  ok(added.ok === true, `addAccount(hma) ok (label ${added.account?.label})`);
  ok(walletKeyOf(added.account!.secretRef) === LICENSE, 'license key stored in the ENCRYPTED secret');
  ok(added.account!.meta.walletKey === undefined, 'license key NOT in account.meta (state.json)');

  console.log('\n[2] load locations');
  const n = await facade.refreshTargets('hma');
  const targets = await facade.listTargets('hma');
  const us = targets.filter((t) => t.country === 'US');
  ok(targets.length > 10, `listTargets -> ${targets.length} locations (${us.length} US)`);
  const cityA = us[0], cityB = us[1];
  console.log(`   using A=${cityA.label} (${cityA.key})  B=${cityB.label} (${cityB.key})`);

  console.log('\n[3] multiple ports in ONE location (concurrent on one device)');
  const r = await facade.addPorts(cityA.key, 2);
  ok(r.added.length >= 1, `addPorts(A,2) -> ${r.added.length} port(s)${r.noteKey ? ' note=' + r.noteKey : ''}`);
  const aKeys = r.added.map((p) => p.key);
  await waitOnline(aKeys);
  const aRows = state.getState().ports.filter((p) => aKeys.includes(p.key));
  const aOnline = aRows.filter((p) => p.state.kind === 'online');
  ok(aOnline.length === aKeys.length, `all ${aKeys.length} port(s) in A online`);
  const ips = aKeys.map((k) => ({ k, ip: exitIp(proxyOf(k)) }));
  ips.forEach(({ k, ip }) => console.log(`     ${k} -> ${ip}`));
  const realIps = ips.map((x) => x.ip).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  ok(realIps.length === aKeys.length, 'every port returns a real exit IP through its proxy');
  if (aKeys.length >= 2) ok(new Set(realIps).size === realIps.length, 'the concurrent ports have DISTINCT exit IPs');

  console.log('\n[4] add a port in ANOTHER location (tolerant: some HMA cities share a gateway pool)');
  const r2 = await facade.addPorts(cityB.key, 1);
  const bKey = r2.added[0]?.key;
  if (bKey) {
    await waitOnline([bKey]);
    const ip = exitIp(proxyOf(bKey));
    console.log(`     ${bKey} -> ${ip}`);
    ok(/^\d+\.\d+\.\d+\.\d+$/.test(ip), 'B port online with a real exit IP');
    await facade.removePorts([bKey]); // free it so A's pool is the clean subject below
  } else {
    console.log(`     addPorts(B,1) added 0 (note=${r2.noteKey}) — B's gateways overlap A's held pool; skipping (not a failure)`);
  }

  console.log('\n[5] Change IP on A while BOTH its gateways are in use → clear note, stays in city, no relocation');
  if (aKeys.length >= 2 && aOnline.length >= 2) {
    const before = exitIp(proxyOf(aKeys[0]));
    const res = await facade.rotatePort(aKeys[0]);
    const after = exitIp(proxyOf(aKeys[0]));
    console.log(`     before=${before} after=${after} changed=${res.changed} note=${res.noteKey ?? '-'}`);
    ok(res.changed === false && Boolean(res.noteKey), `reported a clear note (${res.noteKey}), IP kept`);
    ok(state.getState().ports.find((p) => p.key === aKeys[0])?.locationKey === cityA.key, 'port stayed in the same city (no silent relocation)');
  }

  console.log('\n[6] delete one A port → frees a gateway; then Change IP on the other → real new IP, same city');
  if (aKeys.length >= 2) {
    const beforeCount = state.getState().ports.length;
    await facade.removePorts([aKeys[1]]);
    ok(state.getState().ports.length === beforeCount - 1 && !state.getState().ports.some((p) => p.key === aKeys[1]), `deleted ${aKeys[1]}`);
    await sleep(1500);
    const before = exitIp(proxyOf(aKeys[0]));
    const res = await facade.rotatePort(aKeys[0]);
    await waitOnline([aKeys[0]]);
    const after = exitIp(proxyOf(aKeys[0]));
    console.log(`     before=${before} after=${after} changed=${res.changed} note=${res.noteKey ?? '-'}`);
    ok(res.changed === true && /^\d+\.\d+\.\d+\.\d+$/.test(after) && before !== after, 'Change IP gave a NEW exit IP in the same city');
    ok(state.getState().ports.find((p) => p.key === aKeys[0])?.locationKey === cityA.key, 'still in the same city');
  }

  console.log('\n[7] cleanup: stop + remove account');
  await facade.removeAccount(added.account!.id);
  ok(state.getState().ports.length === 0, 'all ports removed with the account');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error('E2E crashed:', e); fail++; })
  .finally(async () => {
    for (const p of state.getState().ports) await engine.stop(p.key).catch(() => {});
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(fail > 0 ? 1 : 0);
  });
