import { countryName } from './countryName';

/** Anything that names a location: a `Target`, a `PortRow`, a port group. */
export interface LocationLike {
  /** ISO 3166-1 alpha-2. */
  country: string;
  city: string;
  /** The provider says the location covers the whole country (`Target.countryWide`). */
  countryWide?: boolean;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The location covers a whole country, so its "city" is only the country's name: the
 * provider says so (`countryWide`), or the city is empty, or it is the country's English
 * name (a provider catalog in English: ZoogVPN's "Germany", "Japan"), or already its name
 * in `language`.
 */
export function isCountryWide(loc: LocationLike, language: string): boolean {
  if (loc.countryWide) return true;
  const city = fold(loc.city);
  if (!city) return true;
  return city === fold(countryName(loc.country, 'en')) || city === fold(countryName(loc.country, language));
}

/**
 * How the UI names a location: its city, or for a country-wide location the country's
 * name in the UI language ("Đức", not "Germany", in Vietnamese).
 */
export function locationName(loc: LocationLike, language: string): string {
  return isCountryWide(loc, language) ? countryName(loc.country, language) : loc.city;
}
