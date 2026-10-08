const FLAG_URLS = import.meta.glob('../assets/flags/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** ISO-3166 alpha-2 (any case) → bundled flag PNG URL, if we ship one. */
export function flagUrl(country: string): string | undefined {
  return FLAG_URLS[`../assets/flags/${country.toLowerCase()}.png`];
}

/**
 * Country flag at a fixed 4:3-ish box so rows never shift. Countries we don't
 * ship a flag for fall back to their two-letter code in the same box.
 */
export function Flag({ country, size = 'md' }: { country: string; size?: 'sm' | 'md' }) {
  const url = flagUrl(country);
  if (!url) {
    return (
      <span className={`flag flag-${size} flag-code`} aria-hidden="true">
        {country.toUpperCase().slice(0, 2)}
      </span>
    );
  }
  return <img className={`flag flag-${size}`} src={url} alt="" aria-hidden="true" draggable={false} />;
}
