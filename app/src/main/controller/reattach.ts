import { makePortKey, splitPortKey, type PortRow, type ProviderId, type Target } from '../../shared/contracts';

/**
 * Boot-time re-attach of ports whose location no longer exists (spec §6.8 migration).
 *
 * A provider may regroup its locations between releases — e.g. ZoogVPN going from one
 * location per host (`zoogvpn:JP-JP3`, servers `[jp3.webunlim.com]`) to one per
 * (country, city) whose `servers` list every host. A row whose `locationKey` is not
 * among its provider's current target keys is moved, in order of preference, to:
 *   1. the target whose pool contains the row's pinned `server`;
 *   2. the target holding a server named in the old key (`findByOldKey`);
 *   3. the target matching the old key's country code and region (`findByCountry`),
 *      unpinned, for a server that vanished from every pool.
 * Its key becomes `<newLocationKey>#<n>` with the smallest free `n`; everything else on
 * the row (proxy port, account, auto-rotate) carries over. A row that matches nothing is
 * left alone and fails with `no-server` when started.
 *
 * Generic over providers: only `Target.key`/`country`/`city`/`servers` are consulted.
 * Providers absent from `targetsByProvider` (no accounts, or their catalog failed to
 * load) are skipped, so a transient failure never detaches anything.
 */
export function reattachPorts(
  ports: PortRow[],
  targetsByProvider: Map<ProviderId, Target[]>,
  /** Called for each row moved: the row as it was, and its new location key. */
  onMove?: (row: PortRow, toLocationKey: string) => void,
): PortRow[] {
  const used = new Map<string, Set<number>>();
  for (const p of ports) {
    const parts = splitPortKey(p.key);
    if (!parts) continue;
    const set = used.get(parts.locationKey) ?? new Set<number>();
    set.add(parts.n);
    used.set(parts.locationKey, set);
  }

  return ports.map((p) => {
    const targets = targetsByProvider.get(p.providerId);
    if (!targets || targets.length === 0 || targets.some((t) => t.key === p.locationKey)) return p;
    const match = findByServer(targets, p.server) ?? findByOldKey(targets, p.locationKey) ?? findByCountry(targets, p.locationKey);
    if (!match) return p;
    const set = used.get(match.target.key) ?? new Set<number>();
    let n = 1;
    while (set.has(n)) n += 1;
    set.add(n);
    used.set(match.target.key, set);
    onMove?.(p, match.target.key);
    const { serverIp: _staleIp, server: _staleServer, ...rest } = p;
    return {
      ...rest,
      key: makePortKey(match.target.key, n),
      locationKey: match.target.key,
      // No server for a country-level match: the first start picks the best free one.
      ...(match.server ? { server: match.server } : {}),
      ...(match.server && match.server === p.server && p.serverIp ? { serverIp: p.serverIp } : {}),
      label: match.target.label,
      country: match.target.country,
      city: match.target.city,
    };
  });
}

/**
 * `reattachPorts`, plus the persisted alias map old location key → new location key
 * (`AppState.locationAliases`), so a script still posting a retired bare location key to
 * the webhook (`zoogvpn:JP-JP3`) reaches the port that moved (spec §6.6). Where one old
 * location's rows went to several targets, its lowest-numbered row decides (that is the
 * port a bare key means); an alias written by an earlier run is replaced.
 */
export function reattachWithAliases(
  ports: PortRow[],
  targetsByProvider: Map<ProviderId, Target[]>,
  aliases: Record<string, string>,
): { ports: PortRow[]; aliases: Record<string, string> } {
  const best = new Map<string, { n: number; to: string }>();
  const out = reattachPorts(ports, targetsByProvider, (row, to) => {
    const n = splitPortKey(row.key)?.n ?? 0;
    const prev = best.get(row.locationKey);
    if (!prev || n < prev.n) best.set(row.locationKey, { n, to });
  });
  const next = { ...aliases };
  for (const [from, { to }] of best) next[from] = to;
  return { ports: out, aliases: next };
}

interface Match {
  target: Target;
  server?: string;
}

function findByServer(targets: Target[], server: string | undefined): Match | undefined {
  if (!server) return undefined;
  const target = targets.find((t) => t.servers.includes(server));
  return target ? { target, server } : undefined;
}

/** The location part of a key (after `<provider>:`), lower-cased. */
function locationPart(key: string): string {
  return key.slice(key.indexOf(':') + 1).toLowerCase();
}

/** `JP-JP3` → `jp, jp3`; `US-US1-EAST` → `us, us1, east`. */
function keyTokens(key: string): string[] {
  return locationPart(key).split(/[^a-z0-9.]+/).filter(Boolean);
}

/** A server named in the old key: the location part or one of its tokens equal to a
 * whole server token (`zoogvpn:jp3.webunlim.com`), else a numbered token equal to a
 * server's first DNS label (`JP-JP3` → `jp3.webunlim.com`). Un-numbered tokens never
 * match a label, so a bare country code cannot pick some `<cc>.<domain>` host. */
function findByOldKey(targets: Target[], locationKey: string): Match | undefined {
  const tokens = keyTokens(locationKey);
  const whole = new Set([locationPart(locationKey), ...tokens]);
  const numbered = new Set(tokens.filter((t) => /\d/.test(t)));
  const byWhole = (s: string) => whole.has(s.toLowerCase());
  const byLabel = (s: string) => numbered.has(s.toLowerCase().split('.')[0]);
  for (const test of [byWhole, byLabel]) {
    for (const target of targets) {
      const server = target.servers.find(test);
      if (server) return { target, server };
    }
  }
  return undefined;
}

/**
 * Last resort, for a row whose server is gone from every pool: the old key's leading
 * country code (`US-US1-EAST` → `us`) and region labels (alphabetic tokens of three
 * letters or more → `east`) against each target's `country` and its city/key words.
 * Exactly one match wins; otherwise the country-wide target (key `<provider>:<CC>`), if
 * there is one. Anything more ambiguous is left alone.
 */
function findByCountry(targets: Target[], locationKey: string): Match | undefined {
  const tokens = keyTokens(locationKey);
  const cc = tokens[0];
  if (!cc || !/^[a-z]{2}$/.test(cc)) return undefined;
  const inCountry = targets.filter((t) => t.country.toLowerCase() === cc);
  const labels = tokens.slice(1).filter((t) => /^[a-z]{3,}$/.test(t));
  const words = (t: Target) => new Set([...t.city.toLowerCase().split(/[^a-z0-9]+/), ...keyTokens(t.key)]);
  const byRegion = labels.length > 0 ? inCountry.filter((t) => labels.some((l) => words(t).has(l))) : inCountry;
  if (byRegion.length === 1) return { target: byRegion[0] };
  const countryWide = inCountry.find((t) => locationPart(t.key) === cc);
  return countryWide ? { target: countryWide } : undefined;
}
