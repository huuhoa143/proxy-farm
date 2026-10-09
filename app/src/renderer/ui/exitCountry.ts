const CODE_RE = /^[A-Z]{2}$/;

export interface ExitCountryView {
  /** The country an exit is tagged with: the location's, i.e. what the provider sells. */
  tag?: string;
  /** Where IP geolocation puts the exit, only when it disagrees with `tag`. */
  geo?: string;
}

/**
 * Which country to tag an online port's exit with. The location's country wins over the
 * exit-IP probe's geolocation: IP databases disagree with each other (ifconfig.co said
 * BR, ipinfo HK, for an exit NordVPN sells as Vietnam) and providers sell virtual
 * locations, so the probe's answer is a hint, not the truth. Without a location country
 * (an imported file with none set) the geolocation is all there is.
 */
export function exitCountry(locationCountry: string, geoCountry: string): ExitCountryView {
  const location = locationCountry.toUpperCase();
  const geo = geoCountry.toUpperCase();
  if (!CODE_RE.test(location)) return CODE_RE.test(geo) ? { tag: geo } : {};
  return CODE_RE.test(geo) && geo !== location ? { tag: location, geo } : { tag: location };
}
