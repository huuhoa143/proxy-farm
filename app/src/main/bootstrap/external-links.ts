import { isAllowedExternalUrl } from '../../shared/links';

/**
 * Opens `url` in the user's default browser when it is on the allowlist (this
 * project's GitHub pages, see `isAllowedExternalUrl`), and does nothing otherwise.
 * Used by the window-open / will-navigate handlers and the Help menu, so a link
 * injected into the renderer cannot make the app launch arbitrary URLs or schemes.
 * Returns whether the URL was opened.
 */
export function openExternalIfAllowed(
  url: string,
  openExternal: (url: string) => Promise<void>,
  log: (msg: string, err?: unknown) => void = () => undefined,
): boolean {
  if (!isAllowedExternalUrl(url)) {
    log(`blocked external link: ${safeForLog(url)}`);
    return false;
  }
  void openExternal(url).catch((err) => log('opening external link failed', err));
  return true;
}

/** Scheme + host only: a blocked URL may carry tokens in its path or query. */
function safeForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(unparseable URL)';
  }
}
