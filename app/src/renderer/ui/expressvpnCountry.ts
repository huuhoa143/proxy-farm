import catalog from '../../../resources/catalogs/expressvpn-servers.json';

/** Lower case, letters and digits only. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Folded location slug (`usanewyork`, from `usa-newyork-ca-version-2…`) and folded
 * country name (`usa`) → ISO country code, from the bundled ExpressVPN catalog. */
const BY_SLUG = new Map<string, string>();
for (const s of catalog.servers) {
  BY_SLUG.set(fold(s.host.replace(/-ca-version-2\..*$/, '')), s.country);
  if (!BY_SLUG.has(fold(s.countryName))) BY_SLUG.set(fold(s.countryName), s.country);
}

/**
 * The country of an ExpressVPN `.ovpn` download, named `my_expressvpn_<location>_<udp|tcp>.ovpn`
 * (`my_expressvpn_vietnam_udp.ovpn` → VN): its location matched against the catalog,
 * exactly, else by the longest known slug it starts with (`uk-wembley` → `uk`). `null` for
 * a file not named that way, `''` for an ExpressVPN name the catalog does not know.
 */
export function expressvpnCountryFromFilename(name: string): string | null {
  const m = /^my_expressvpn_(.+?)(?:_(?:udp|tcp))?\.ovpn$/i.exec(name.split(/[\\/]/).pop() ?? '');
  if (!m) return null;
  const location = fold(m[1]);
  const exact = BY_SLUG.get(location);
  if (exact) return exact;
  let best = '';
  for (const slug of BY_SLUG.keys()) if (location.startsWith(slug) && slug.length > best.length) best = slug;
  return best ? BY_SLUG.get(best)! : '';
}
