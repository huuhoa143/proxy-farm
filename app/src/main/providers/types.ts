/**
 * Local provider-module types. Re-exports the shared contracts (spec §5) so
 * every file under providers/ imports from one place, plus a couple of
 * narrow helper types that are purely internal to this module (not relied on
 * by other v2 modules, so they don't belong in contracts.ts).
 */
export type {
  Provider,
  ProviderId,
  Target,
  Account,
  AccountSecret,
  CheckResult,
  EndpointSpec,
  OpenVpnEndpoint,
  WireguardEndpoint,
} from '../../shared/contracts';

/** A single candidate exit IP for a catalog location (spec §5.1). */
export interface CatalogIp {
  ip: string;
  firstSeen: number; // unix seconds
  lastOk: number | null; // unix seconds, or null if never confirmed
}

/** One catalog location: a stable key plus the IPs known to serve it. */
export interface CatalogLocation {
  key: string;
  country: string;
  city: string;
  ips: CatalogIp[];
}

export interface Catalog {
  fetched: number;
  locations: CatalogLocation[];
}
