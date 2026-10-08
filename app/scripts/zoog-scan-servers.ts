/**
 * Maintainer tool: enumerates ZoogVPN's numbered hosts via DNS and (with --write)
 * updates the bundled server list, resources/catalogs/zoogvpn-servers.json.
 *
 * Why: ZoogVPN's exit IP is the server's own IP, so every extra host of a location is
 * one more exit IP for it. Hosts are numbered per country (`<cc><n>.webunlim.com`, some
 * `.zoogvpn.com`, US ones `us<n>.<region>.webunlim.com`), one A record each, and the
 * list this app shipped with held only a fraction of them (spec §5.2).
 *
 * How:
 *   1. Learn the numbered series (prefix + optional region) from the bundled list.
 *   2. For each series and domain, resolve n = 1, 2, … until --misses consecutive names
 *      fail past the highest n already listed.
 *   3. Merge (src/main/providers/zoogvpn/host-scan.ts): bundled hosts that still resolve
 *      stay, new hosts are added unless their IP is already a server of the location,
 *      bundled hosts that no longer resolve are dropped.
 *
 * DNS only; no VPN account needed. Which hosts an account's plan may use is not known
 * here: the app learns that per (account, server) at runtime (spec §6.8).
 *
 * Run from the app directory:  pnpm scan:zoog-servers [--write] [--misses 6] [--conc 16]
 *                              [--only JP,DE]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  ZOOG_DOMAINS,
  formatServersFile,
  mergeScan,
  seriesOf,
  zoogHostName,
  type ResolvedHost,
} from '../src/main/providers/zoogvpn/host-scan';
import { groupLocations } from '../src/main/providers/zoogvpn/index';
import type { ZoogServer } from '../src/main/providers/zoogvpn/servers';

const APP = process.cwd();
const LIST = path.join(APP, 'resources', 'catalogs', 'zoogvpn-servers.json');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const WRITE = process.argv.includes('--write');
const MISSES = Number(arg('misses') ?? 6);
const CONC = Number(arg('conc') ?? 16);
const ONLY = arg('only')?.toUpperCase().split(',');

const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/** A records of a host; [] when it has none. Transient failures retry, then throw. */
async function resolveA(host: string): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return [...new Set(await dns.resolve4(host))].sort();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (NO_RECORD.has(code)) return [];
      if (attempt >= 3) throw new Error(`${host}: DNS ${code || String(err)}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const bundled = (JSON.parse(readFileSync(LIST, 'utf8')) as { servers: ZoogServer[] }).servers;
  const inScope = (s: { country: string }) => !ONLY || ONLY.includes(s.country);

  // A wildcard record would make every name "exist" and the scan meaningless.
  for (const domain of ZOOG_DOMAINS) {
    const probe = `zz${randomBytes(4).toString('hex')}.${domain}`;
    if ((await resolveA(probe)).length > 0) throw new Error(`${domain} answers for ${probe}: wildcard DNS, aborting`);
  }

  const bundledIps = new Map<string, string[]>();
  await mapLimit(bundled, CONC, async (s) => {
    bundledIps.set(s.host, await resolveA(s.host));
  });

  const found: ResolvedHost[] = [];
  const series = seriesOf(bundled).filter(inScope);
  console.log(`enumerating ${series.length} series × ${ZOOG_DOMAINS.length} domains (stop after ${MISSES} misses)…`);
  await mapLimit(
    series.flatMap((s) => ZOOG_DOMAINS.map((domain) => ({ s, domain }))),
    CONC,
    async ({ s, domain }) => {
      let misses = 0;
      for (let n = 1; n <= s.knownMax || misses < MISSES; n++) {
        const host = zoogHostName({ prefix: s.prefix, n, region: s.region, domain });
        const ips = await resolveA(host);
        if (ips.length === 0) {
          misses++;
          continue;
        }
        misses = 0;
        found.push({ host, country: s.country, countryName: s.countryName, ips });
      }
    },
  );

  // With --only, other countries pass through untouched even if a host stopped resolving.
  for (const s of bundled) {
    if (!inScope(s) && !bundledIps.get(s.host)?.length) bundledIps.set(s.host, [`unscanned:${s.host}`]);
  }
  const result = mergeScan(bundled, bundledIps, found);

  const before = groupLocations(bundled);
  const after = groupLocations(result.servers);
  console.log('\nlocation                      before  after');
  for (const t of after.filter(inScope)) {
    const old = before.find((b) => b.key === t.key)?.servers.length ?? 0;
    console.log(`${t.key.padEnd(30)}${String(old).padStart(6)}${String(t.servers.length).padStart(7)}`);
  }
  console.log(`\n${bundled.length} hosts listed → ${result.servers.length} after the scan`);
  if (result.vanished.length) console.log(`dropped (no longer resolve): ${result.vanished.join(', ')}`);
  for (const d of result.duplicates) console.log(`skipped ${d.host}: same IP as ${d.sameAs}`);
  for (const c of result.crossLocation) console.log(`shared across locations: ${c.hosts.join(', ')}`);

  if (!WRITE) {
    console.log('\ndry run — pass --write to update the list');
    return;
  }
  writeFileSync(LIST, formatServersFile(result.servers, new Date().toISOString().slice(0, 10)));
  console.log(`\nwrote ${path.relative(APP, LIST)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
