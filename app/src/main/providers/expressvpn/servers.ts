/**
 * ExpressVPN's server list (spec §5.6). ExpressVPN publishes no API for it, so the list
 * is bundled at `app/resources/catalogs/expressvpn-servers.json`: the hostnames gluetun
 * hard-codes (`internal/provider/expressvpn/updater/hardcoded.go`, MIT), with ISO country
 * codes added. Each hostname is a location's DNS name; the servers behind it are its A
 * records (1–6, stable, TTL 300), found at run time like Surfshark's pools.
 *
 * The list does not update itself: a location ExpressVPN adds is missing until the file
 * is refreshed, and one it retires stops resolving (its port reports no server).
 */
import { readFileSync } from 'node:fs';
import { resourcePath } from '../../resources-root';
import type { Target } from '../types';

export interface ExpressServer {
  host: string;
  /** ISO 3166-1 alpha-2 of the country the location is sold as. */
  country: string;
  /** ExpressVPN's English name of that country, without any "(via …)". */
  countryName: string;
  /** Empty for a country-wide location. */
  city: string;
  /** Where the servers really stand when ExpressVPN says so ("India (via UK)"). */
  via?: string;
}

interface ServersFile {
  source: string;
  servers: ExpressServer[];
}

export function loadServers(serversPath: string = resourcePath('catalogs', 'expressvpn-servers.json')): ExpressServer[] {
  return (JSON.parse(readFileSync(serversPath, 'utf8')) as ServersFile).servers;
}

/** The location's city as shown: its own, or "via <place>" for a location that stands
 * elsewhere, or the country's name for a country-wide one (the UI localises that). */
function cityOf(s: ExpressServer): string {
  if (s.via) return `via ${s.via}`;
  return s.city || s.countryName;
}

/**
 * Location key (spec §6.8): `expressvpn:<CC>` for a country-wide location, else
 * `expressvpn:<CC>-<CITY>` with the city (or "via <place>") upper-cased and
 * non-alphanumerics turned into `-`, like ZoogVPN's. Derived from data only, so it is
 * stable across catalog updates.
 */
export function expressLocationKey(s: ExpressServer): string {
  if (!s.city && !s.via) return `expressvpn:${s.country}`;
  const slug = cityOf(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `expressvpn:${s.country}-${slug}`;
}

/** One target per location, its servers the location's hostnames in catalog order. */
export function groupLocations(servers: ExpressServer[]): Target[] {
  const byKey = new Map<string, Target>();
  for (const s of servers) {
    const key = expressLocationKey(s);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.servers.includes(s.host)) existing.servers.push(s.host);
      continue;
    }
    const countryWide = !s.city && !s.via;
    byKey.set(key, {
      key,
      providerId: 'expressvpn',
      country: s.country,
      city: cityOf(s),
      label: s.via ? `${s.countryName} (via ${s.via})` : countryWide ? s.countryName : `${s.countryName} — ${s.city}`,
      ...(countryWide ? { countryWide: true } : {}),
      // ExpressVPN itself says these servers stand elsewhere ("India (via UK)").
      ...(s.via ? { virtualLocation: true } : {}),
      servers: [s.host],
    });
  }
  return [...byKey.values()];
}
