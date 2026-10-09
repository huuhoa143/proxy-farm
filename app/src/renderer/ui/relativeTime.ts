/** "now", "3 minutes ago", "2 hours ago"… in the UI language. */
export function relativeTime(at: number, now: number, language: string): string {
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 60) return rtf.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}
