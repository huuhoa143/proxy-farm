import { describe, expect, it } from 'vitest';
import { countryName } from './countryName';

describe('countryName', () => {
  it('names a country from its ISO code in the UI language', () => {
    expect(countryName('JP', 'en')).toBe('Japan');
    expect(countryName('jp', 'vi')).toBe('Nhật Bản');
    expect(countryName('AT', 'vi')).toBe('Áo');
  });

  it('uses the Vietnamese exonym where CLDR keeps the English name', () => {
    expect(countryName('IT', 'vi')).toBe('Ý');
    expect(countryName('IT', 'vi-VN')).toBe('Ý');
    expect(countryName('IT', 'en')).toBe('Italy');
  });

  it('falls back to the code for anything that is not a region code', () => {
    expect(countryName('??', 'en')).toBe('??');
  });
});
