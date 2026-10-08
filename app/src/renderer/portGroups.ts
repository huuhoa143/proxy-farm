import type { PortRow, ProviderId, Target } from '../shared/contracts';
import { splitPortKey } from '../shared/contracts';
import { countryName } from './ui/countryName';

/** All ports of one location, as one group on the main screen (spec §4.1). */
export interface PortGroup {
  locationKey: string;
  country: string;
  city: string;
  providerId: ProviderId;
  /** The location as listed by `listTargets`, when it is still in the catalog. */
  target?: Target;
  rows: PortRow[];
  online: number;
}

/** The `n` of a `<location>#<n>` port key; undefined for a bare (pre-rev-3) key. */
export function portNumber(row: Pick<PortRow, 'key'>): number | undefined {
  return splitPortKey(row.key)?.n;
}

/**
 * Group ports by location. Groups sort by country name (in the UI language),
 * then city, then provider, so a group never jumps around while its ports
 * change state; ports sort by their number within a group.
 */
export function groupPorts(rows: readonly PortRow[], targets: readonly Target[], language: string): PortGroup[] {
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const groups = new Map<string, PortGroup>();
  for (const row of rows) {
    const locationKey = row.locationKey || row.key;
    let group = groups.get(locationKey);
    if (!group) {
      const target = byKey.get(locationKey);
      group = {
        locationKey,
        country: target?.country ?? row.country,
        city: target?.city ?? row.city,
        providerId: target?.providerId ?? row.providerId,
        target,
        rows: [],
        online: 0,
      };
      groups.set(locationKey, group);
    }
    group.rows.push(row);
    if (row.state.kind === 'online') group.online += 1;
  }
  const list = Array.from(groups.values());
  const names = new Map(list.map((g) => [g.country, countryName(g.country, language)]));
  list.sort(
    (a, b) =>
      names.get(a.country)!.localeCompare(names.get(b.country)!, language) ||
      a.city.localeCompare(b.city, language) ||
      a.providerId.localeCompare(b.providerId) ||
      a.locationKey.localeCompare(b.locationKey),
  );
  for (const group of list) {
    group.rows.sort((a, b) => (portNumber(a) ?? 0) - (portNumber(b) ?? 0) || a.proxyPort - b.proxyPort);
  }
  return list;
}

/**
 * Ports each provider may still add under its port limit (spec §4.2, §6.8).
 * Providers without a limit (0 / missing) are absent, meaning unlimited.
 */
export function remainingByProvider(
  rows: readonly PortRow[],
  limits: Partial<Record<ProviderId, number>>,
): Partial<Record<ProviderId, number>> {
  const out: Partial<Record<ProviderId, number>> = {};
  for (const [providerId, limit] of Object.entries(limits) as Array<[ProviderId, number | undefined]>) {
    if (!limit) continue;
    const enabled = rows.filter((r) => r.providerId === providerId && r.enabled).length;
    out[providerId] = Math.max(0, limit - enabled);
  }
  return out;
}

/** How many more ports a location can take right now: free servers, capped by the
 * provider limit; none for a location outside the plan. */
export function addableCount(target: Target, remaining: Partial<Record<ProviderId, number>>): number {
  if (target.notInPlan) return 0;
  const free = target.freeServers ?? target.servers.length;
  const cap = remaining[target.providerId];
  return cap === undefined ? free : Math.min(free, cap);
}

/** Why "+ Add port" is unavailable for a location, if it is. */
export function addPortBlock(
  target: Target,
  remaining: Partial<Record<ProviderId, number>>,
): 'not-in-plan' | 'no-free-server' | 'limit-reached' | undefined {
  if (target.notInPlan) return 'not-in-plan';
  if (remaining[target.providerId] === 0) return 'limit-reached';
  if ((target.freeServers ?? target.servers.length) === 0) return 'no-free-server';
  return undefined;
}
