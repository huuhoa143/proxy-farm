/**
 * Maintainer tool: finds, for every HMA location in the seed catalog, the servers that
 * accept HMA *device credentials*, and (with --write) records them in
 * resources/catalogs/hma-ovpn-seed.json as that location's `ips` list.
 *
 * Why: with HMA the exit IP is the server's own IP, so a location with one server can
 * never rotate to a new IP in the same city, and has no fallback when that server dies.
 * A location's servers usually sit in one /24, but not every OpenVPN server there serves
 * HMA: the infrastructure is shared across Gen Digital brands, and a server belonging to
 * another brand's tenant answers AUTH_FAILED to HMA devices.
 *
 * How:
 *   1. Probe each seed IP's /24 with a single 14-byte OpenVPN hello (P_CONTROL_HARD_RESET_
 *      CLIENT_V2) on udp/1194 and collect the hosts that answer as OpenVPN servers.
 *   2. For each location, run a real device-credential handshake (the app's own provider
 *      + config renderer, sing-box reading its config from stdin, so no secret touches
 *      disk) against its existing IPs, then the newly found ones, keeping only servers
 *      that establish. A newly found server must also geolocate to the location's country.
 *   3. Stop at --max verified servers per location.
 *
 * A /24 that holds seed IPs of more than one location is not mined for new servers (they
 * could not be attributed to a location); its existing IPs are still verified.
 *
 * Run from the app directory:  pnpm scan:hma-servers [--write] [--max 4] [--only KEY,KEY]
 *                              [--conc 3] [--token /path/to/tokenCoreSE.json]
 * Needs HMA installed and signed in on this Mac (device credentials are read from the
 * world-readable tokenCoreSE.json) and the bundled sing-box (`pnpm prebuild`).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import https from 'node:https';
import path from 'node:path';
import { parseDeviceCreds } from '../src/main/providers/hma/token';
import { createHmaProvider } from '../src/main/providers/hma/index';
import { renderConfig } from '../src/main/engine/render-config';
import { setResourcesRoot } from '../src/main/resources-root';
import type { Account, AccountSecret, Target } from '../src/shared/contracts';

interface SeedLocation {
  key: string;
  country: string;
  countryName?: string;
  city: string;
  ip: string;
  ips?: string[];
  port?: number;
  proto?: string;
}

type Verdict = 'OK' | 'AUTH' | 'TIMEOUT';

const APP = process.cwd();
const SEED = path.join(APP, 'resources', 'catalogs', 'hma-ovpn-seed.json');
const DEFAULT_TOKEN = '/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const WRITE = process.argv.includes('--write');
const MAX = Number(arg('max') ?? 4);
const CONC = Number(arg('conc') ?? 3);
const ONLY = arg('only')?.split(',');
const TOKEN = arg('token') ?? DEFAULT_TOKEN;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const subnet = (ip: string) => ip.split('.').slice(0, 3).join('.');
const lastOctet = (ip: string) => Number(ip.split('.')[3]);

function singboxBinary(): string {
  const key =
    process.platform === 'win32' ? 'windows-amd64' : process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
  const bin = path.join(APP, 'resources', 'sing-box', key, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
  if (!existsSync(bin)) throw new Error(`sing-box not found at ${bin} — run \`pnpm prebuild\` first`);
  return bin;
}

/** Step 1: one OpenVPN hello per host of each /24; returns the hosts that answered. */
async function probeSubnets(subnets: string[]): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>(subnets.map((s) => [s, new Set<string>()]));
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    // P_CONTROL_HARD_RESET_SERVER_V2 = opcode 8 in the high 5 bits.
    if (msg.length > 0 && msg[0] >> 3 === 8) found.get(subnet(rinfo.address))?.add(rinfo.address);
  });
  sock.on('error', () => undefined);
  await new Promise<void>((resolve) => sock.bind(0, resolve));
  for (const s of subnets) {
    for (let host = 1; host <= 254; host++) {
      const hello = Buffer.concat([Buffer.from([0x38]), randomBytes(8), Buffer.alloc(5)]);
      sock.send(hello, 1194, `${s}.${host}`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(1);
    }
  }
  await sleep(5000);
  sock.close();
  return found;
}

/** Step 2: a real device-credential handshake, reported as soon as it resolves. */
function handshake(ip: string, slot: number, bin: string, ctx: HandshakeCtx): Promise<Verdict> {
  return new Promise((resolve) => {
    const target: Target = { key: 'scan', providerId: 'hma', country: 'XX', city: 'scan', label: 'scan', servers: [ip] };
    const config = renderConfig({
      endpoint: ctx.provider.bind(target, ip, ctx.account, ctx.secret),
      listen: { host: '127.0.0.1', port: 46000 + slot, proxyAuth: { username: 'scan', password: randomBytes(8).toString('hex') } },
      clash: { port: 47000 + slot, secret: randomBytes(8).toString('hex') },
    });
    const child = spawn(bin, ['run', '-c', 'stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const finish = (v: Verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(v);
    };
    const onData = (b: Buffer) => {
      const s = b.toString();
      if (/tunnel established/i.test(s)) finish('OK');
      else if (/authentication failed/i.test(s)) finish('AUTH');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => finish('TIMEOUT'));
    child.stdin.on('error', () => undefined);
    child.stdin.end(config);
    const timer = setTimeout(() => finish('TIMEOUT'), 25000);
  });
}

interface HandshakeCtx {
  provider: ReturnType<typeof createHmaProvider>;
  account: Account;
  secret: AccountSecret;
}

function countryOf(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(`https://ipinfo.io/${ip}/json`, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve((JSON.parse(body) as { country?: string }).country ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

interface LocationResult {
  key: string;
  before: string[];
  verified: string[];
  rejected: string[];
  wrongCountry: string[];
}

async function main(): Promise<void> {
  setResourcesRoot(path.join(APP, 'resources'));
  const bin = singboxBinary();
  const { udid, password } = parseDeviceCreds(readFileSync(TOKEN, 'utf8'));
  const ctx: HandshakeCtx = {
    provider: createHmaProvider(),
    account: { id: 'scan', providerId: 'hma', label: 'scan', meta: {}, secretRef: '' },
    secret: { kind: 'userpass', username: udid, password },
  };

  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { fetched: number; locations: SeedLocation[] };
  const locations = seed.locations.filter((l) => !ONLY || ONLY.includes(l.key));
  const existingOf = (l: SeedLocation) => (l.ips?.length ? l.ips : [l.ip]);

  // Which locations own each /24 (from every seed location, not just --only ones).
  const owners = new Map<string, Set<string>>();
  for (const l of seed.locations) for (const ip of existingOf(l)) (owners.get(subnet(ip)) ?? owners.set(subnet(ip), new Set()).get(subnet(ip))!).add(l.key);

  const minable = [...new Set(locations.flatMap((l) => existingOf(l).map(subnet)))].filter((s) => owners.get(s)!.size === 1);
  console.log(`probing ${minable.length} /24 subnets with one OpenVPN hello per host…`);
  const responders = await probeSubnets(minable);
  console.log(`OpenVPN servers answering: ${[...responders.values()].reduce((n, s) => n + s.size, 0)}`);

  const results: LocationResult[] = [];
  let slot = 0;
  let next = 0;
  async function worker(): Promise<void> {
    const mySlot = slot++;
    while (next < locations.length) {
      const loc = locations[next++];
      const before = existingOf(loc);
      const fresh = [...new Set(before.flatMap((ip) => [...(responders.get(subnet(ip)) ?? [])]))]
        .filter((ip) => !before.includes(ip))
        .sort((a, b) => lastOctet(a) - lastOctet(b));
      const result: LocationResult = { key: loc.key, before, verified: [], rejected: [], wrongCountry: [] };
      for (const ip of [...before, ...fresh]) {
        if (result.verified.length >= MAX) break;
        // eslint-disable-next-line no-await-in-loop
        const verdict = await handshake(ip, mySlot, bin, ctx);
        if (verdict === 'AUTH') result.rejected.push(ip);
        if (verdict !== 'OK') continue;
        if (!before.includes(ip)) {
          // eslint-disable-next-line no-await-in-loop
          const country = await countryOf(ip);
          if (country !== loc.country) {
            result.wrongCountry.push(ip);
            continue;
          }
        }
        result.verified.push(ip);
      }
      results.push(result);
      const added = result.verified.filter((ip) => !before.includes(ip));
      console.log(
        `${loc.key.padEnd(24)} ${String(result.verified.length).padStart(2)} ok` +
          (added.length ? `  +${added.join(' +')}` : '') +
          (result.rejected.length ? `  refused: ${result.rejected.join(' ')}` : '') +
          (result.verified.length === 0 ? '  ⚠ NO WORKING SERVER (left unchanged)' : ''),
      );
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  const total = results.reduce((n, r) => n + r.verified.length, 0);
  const multi = results.filter((r) => r.verified.length > 1).length;
  console.log(`\n${results.length} locations, ${total} verified servers, ${multi} locations with more than one server`);

  if (!WRITE) {
    console.log('dry run — pass --write to update the seed');
    return;
  }
  const byKey = new Map(results.map((r) => [r.key, r]));
  seed.locations = seed.locations.map((l) => {
    const r = byKey.get(l.key);
    if (!r || r.verified.length === 0) return l;
    const { ips: _old, port, proto, ...rest } = l;
    return { ...rest, ip: r.verified[0], ips: r.verified, port, proto };
  });
  seed.fetched = Math.floor(Date.now() / 1000);
  writeFileSync(SEED, JSON.stringify(seed, null, 1));
  console.log(`wrote ${path.relative(APP, SEED)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
