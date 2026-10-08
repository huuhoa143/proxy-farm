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
