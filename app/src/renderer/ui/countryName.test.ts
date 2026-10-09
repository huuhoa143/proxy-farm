import { describe, expect, it } from 'vitest';
import { cityName, countryName } from './countryName';

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

describe('cityName', () => {
  it('uses the established Vietnamese name of a city the provider names in English', () => {
    expect(cityName('Hanoi', 'vi')).toBe('Hà Nội');
    expect(cityName('Ho Chi Minh City', 'vi')).toBe('TP. Hồ Chí Minh');
    expect(cityName('Da Nang', 'vi-VN')).toBe('Đà Nẵng');
    expect(cityName('Beijing', 'vi')).toBe('Bắc Kinh');
    expect(cityName('Shanghai', 'vi')).toBe('Thượng Hải');
  });

  it('keeps every other name, and every name in English', () => {
    expect(cityName('Bangkok', 'vi')).toBe('Bangkok');
    expect(cityName('Tokyo', 'vi')).toBe('Tokyo');
    expect(cityName('Hanoi', 'en')).toBe('Hanoi');
    expect(cityName('Ho Chi Minh City', 'en')).toBe('Ho Chi Minh City');
  });
});
