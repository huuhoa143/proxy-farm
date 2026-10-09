import { EXIT_IP_MODELS, type PortBucket, type PortCheck, type PortRow, type PortState, type ProviderId } from '../shared/contracts';
import { portBucket } from '../shared/portBucket';
import { countryName } from './ui/countryName';
import { locationName } from './ui/locationName';
import { normaliseSearch } from './ui/searchText';

/** The main screen's port filter (spec §4.1 "Filters"); all parts combine (AND). */
export interface PortFilter {
  status: 'all' | PortBucket;
  provider: ProviderId | 'all';
  query: string;
}

export const NO_FILTER: PortFilter = { status: 'all', provider: 'all', query: '' };

export const STATUS_FILTERS: ReadonlyArray<PortFilter['status']> = ['all', 'alive', 'dead', 'connecting', 'stopped'];

/**
 * A "Check" result held by the renderer (never persisted). `since` is the port's
 * `state.since` when it was checked: the result only describes that connection.
 */
export interface CheckRecord extends PortCheck {
  /** Epoch ms the check finished. */
  at: number;
  since: number;
}

export function stateSince(state: PortState): number | undefined {
  return 'since' in state ? state.since : undefined;
}

/** The port's check result, unless the port reconnected (or changed state) since. */
export function currentCheck(row: PortRow, checks: Readonly<Record<string, CheckRecord>>): CheckRecord | undefined {
  const check = checks[row.key];
  return check && check.since === stateSince(row.state) ? check : undefined;
}

export function bucketOf(row: PortRow, checks: Readonly<Record<string, CheckRecord>>): PortBucket {
  return portBucket(row.state, currentCheck(row, checks));
}

/** Ports per status chip; the four buckets add up to `all`. */
export function bucketCounts(
  rows: readonly PortRow[],
  checks: Readonly<Record<string, CheckRecord>>,
): Record<PortFilter['status'], number> {
  const counts = { all: rows.length, alive: 0, dead: 0, connecting: 0, stopped: 0 };
  for (const row of rows) counts[bucketOf(row, checks)] += 1;
  return counts;
}

/**
 * Whether a port matches a search: its location as named in either UI language
 * (city and country), its country code, exit IP, server IP and local port number.
 * Accent- and case-insensitive, like the location picker.
 */
export function matchesQuery(row: PortRow, query: string): boolean {
  const q = normaliseSearch(query.trim());
  if (!q) return true;
  const parts: string[] = [row.city, row.country, row.label, String(row.proxyPort)];
  for (const language of ['vi', 'en']) {
    parts.push(locationName(row, language), countryName(row.country, language));
  }
  if (row.state.kind === 'online') parts.push(row.state.exitIp);
  if (row.serverIp) parts.push(row.serverIp);
  if (row.server) parts.push(row.server);
  return normaliseSearch(parts.join(' ')).includes(q);
}

/** Provider and search only: the rows the status chips count. */
export function filterByProviderAndQuery(rows: readonly PortRow[], filter: PortFilter): PortRow[] {
  return rows.filter((r) => (filter.provider === 'all' || r.providerId === filter.provider) && matchesQuery(r, filter.query));
}

export function filterPorts(rows: readonly PortRow[], filter: PortFilter, checks: Readonly<Record<string, CheckRecord>>): PortRow[] {
  return filterByProviderAndQuery(rows, filter).filter((r) => filter.status === 'all' || bucketOf(r, checks) === filter.status);
}

export function isFiltering(filter: PortFilter): boolean {
  return filter.status !== 'all' || filter.provider !== 'all' || filter.query.trim() !== '';
}

/** The still-current check results, as `exportPorts` takes them. */
export function exportChecks(rows: readonly PortRow[], checks: Readonly<Record<string, CheckRecord>>): Record<string, PortCheck> {
  const out: Record<string, PortCheck> = {};
  for (const row of rows) {
    const check = currentCheck(row, checks);
    if (check) out[row.key] = check.latencyMs === undefined ? { ok: check.ok } : { ok: check.ok, latencyMs: check.latencyMs };
  }
  return out;
}

const FILTER_STORAGE_KEY = 'proxyfarm.portFilter';

/** The filter, remembered across launches like the collapsed groups. */
export function loadFilter(): PortFilter {
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<keyof PortFilter, unknown>>) : {};
    return {
      status: STATUS_FILTERS.includes(parsed.status as PortFilter['status']) ? (parsed.status as PortFilter['status']) : 'all',
      provider: typeof parsed.provider === 'string' && parsed.provider in EXIT_IP_MODELS ? (parsed.provider as ProviderId) : 'all',
      query: typeof parsed.query === 'string' ? parsed.query : '',
    };
  } catch {
    return NO_FILTER;
  }
}

export function saveFilter(filter: PortFilter): void {
  try {
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // Storage unavailable (private mode / quota): the filter still works for this session.
  }
}
