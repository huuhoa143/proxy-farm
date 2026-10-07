const cache = new Map<string, Intl.DisplayNames | null>();

/**
 * Localised country name from the platform (no hard-coded copy): 'JP' →
 * 'Japan' in en, 'Nhật Bản' in vi. Falls back to the code itself.
 */
export function countryName(code: string, language: string): string {
  const upper = code.toUpperCase();
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
