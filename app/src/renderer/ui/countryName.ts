const cache = new Map<string, Intl.DisplayNames | null>();

/**
 * Where the platform's CLDR data has no exonym for a UI language and so keeps the
 * English name, though everyday usage has one. CLDR's Vietnamese names Italy "Italy"
 * (shown upper-cased as "ITALY" in the picker, and sorted under I); Vietnamese says
 * "Ý". Keyed by base language, then ISO 3166-1 alpha-2 code.
 */
const EXONYMS: Record<string, Record<string, string>> = {
  vi: { IT: 'Ý' },
};

/**
 * Localised country name from the platform: 'JP' → 'Japan' in en, 'Nhật Bản' in vi,
 * corrected by `EXONYMS` where CLDR has none. Falls back to the code itself.
 */
export function countryName(code: string, language: string): string {
  const upper = code.toUpperCase();
  const exonym = EXONYMS[language.toLowerCase().split('-')[0]]?.[upper];
  if (exonym !== undefined) return exonym;
  let names = cache.get(language);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([language], { type: 'region' });
    } catch {
      names = null;
    }
    cache.set(language, names);
  }
  try {
    return names?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/**
 * City names in the providers' catalogs are English ("Hanoi", "Ho Chi Minh City",
 * "Beijing"). Where a UI language has an established name of its own, use it; every
 * other city keeps the provider's name. Only names everyday usage really has belong
 * here, not transliterations nobody writes: Vietnamese says "Bắc Kinh", but "Tokyo" and
 * "Bangkok" stay as they are. Keyed by base language, then the folded English name
 * (`foldName`), so "Ha Noi" and "Hanoi" both match.
 */
const CITY_EXONYMS: Record<string, Record<string, string>> = {
  vi: {
    hanoi: 'Hà Nội',
    hochiminhcity: 'TP. Hồ Chí Minh',
    hochiminh: 'TP. Hồ Chí Minh',
    saigon: 'TP. Hồ Chí Minh',
    danang: 'Đà Nẵng',
    haiphong: 'Hải Phòng',
    cantho: 'Cần Thơ',
    hue: 'Huế',
    beijing: 'Bắc Kinh',
    shanghai: 'Thượng Hải',
    guangzhou: 'Quảng Châu',
    shenzhen: 'Thâm Quyến',
    hongkong: 'Hồng Kông',
    macau: 'Ma Cao',
    macao: 'Ma Cao',
    taipei: 'Đài Bắc',
    phnompenh: 'Phnôm Pênh',
    vientiane: 'Viêng Chăn',
    moscow: 'Mát-xcơ-va',
    london: 'Luân Đôn',
  },
};

/** Lower case, accents dropped, letters and digits only: the `CITY_EXONYMS` key. */
function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** A provider's (English) city name in the UI language, where it has its own; else as given. */
export function cityName(city: string, language: string): string {
  return CITY_EXONYMS[language.toLowerCase().split('-')[0]]?.[foldName(city)] ?? city;
}
