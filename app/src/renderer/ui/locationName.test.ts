import { describe, expect, it } from 'vitest';
import { isCountryWide, locationName } from './locationName';

describe('locationName', () => {
  it('a country-wide location is named after the country, in the UI language', () => {
    expect(locationName({ country: 'DE', city: 'Germany', countryWide: true }, 'vi')).toBe('Đức');
    expect(locationName({ country: 'JP', city: 'Japan', countryWide: true }, 'vi')).toBe('Nhật Bản');
    expect(locationName({ country: 'JP', city: 'Japan', countryWide: true }, 'en')).toBe('Japan');
    // The exonym table in countryName.ts applies too.
    expect(locationName({ country: 'IT', city: 'Italy', countryWide: true }, 'vi')).toBe('Ý');
  });

  it('a city stays a city', () => {
    expect(locationName({ country: 'US', city: 'East' }, 'vi')).toBe('East');
    expect(locationName({ country: 'JP', city: 'Tokyo' }, 'vi')).toBe('Tokyo');
  });

  it('without the flag (an old port row), a city that is just the English country name or empty is country-wide', () => {
    expect(isCountryWide({ country: 'DE', city: 'Germany' }, 'vi')).toBe(true);
    expect(isCountryWide({ country: 'GB', city: 'United Kingdom' }, 'vi')).toBe(true);
    expect(isCountryWide({ country: 'NL', city: '' }, 'vi')).toBe(true);
    expect(isCountryWide({ country: 'VN', city: 'Việt Nam' }, 'vi')).toBe(true); // already localised
    expect(isCountryWide({ country: 'JP', city: 'Tokyo' }, 'vi')).toBe(false);
    expect(locationName({ country: 'DE', city: 'Germany' }, 'vi')).toBe('Đức');
  });

  it('the provider flag covers catalog names CLDR spells differently', () => {
    // CLDR: "Hong Kong SAR China", "Türkiye"; ZoogVPN's catalog: "Hong Kong", "Turkey".
    expect(isCountryWide({ country: 'TR', city: 'Turkey' }, 'vi')).toBe(false);
    expect(locationName({ country: 'TR', city: 'Turkey', countryWide: true }, 'vi')).toBe('Thổ Nhĩ Kỳ');
  });
});
