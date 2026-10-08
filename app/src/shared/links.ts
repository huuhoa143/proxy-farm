/**
 * Every outside link the app shows (Settings → About & help, the Help menu, the
 * updater's fallback), in one place so main and renderer never drift apart.
 *
 * Contact policy: all support goes through GitHub (Discussions for questions, Issues
 * for bugs, private Security Advisories for vulnerabilities). There is no email.
 */

export const REPO_OWNER = 'huuhoa143';
export const REPO_NAME = 'proxy-farm';
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/** A file in the repository's default branch, as rendered by GitHub. */
function repoFile(file: string): string {
  return `${REPO_URL}/blob/main/${file}`;
}

export const LINKS = {
  source: REPO_URL,
  /** Questions and support. */
  discussions: `${REPO_URL}/discussions`,
  /** New bug report (the issue-template chooser). */
  newIssue: `${REPO_URL}/issues/new/choose`,
  /** Private vulnerability report (GitHub Security Advisories). */
  securityAdvisory: `${REPO_URL}/security/advisories/new`,
  releases: `${REPO_URL}/releases`,
  privacy: repoFile('PRIVACY.md'),
  disclaimer: repoFile('DISCLAIMER.md'),
  thirdPartyNotices: repoFile('THIRD_PARTY_NOTICES.md'),
  license: repoFile('LICENSE'),
  security: repoFile('SECURITY.md'),
  support: repoFile('SUPPORT.md'),
} as const;

export type LinkId = keyof typeof LINKS;

const REPO_PATH = `/${REPO_OWNER}/${REPO_NAME}`;

/**
 * The only URLs the app ever hands to the OS browser: https pages of this project's
 * GitHub repository (`https://github.com/huuhoa143/proxy-farm` and anything under it).
 * The URL is parsed first, so dot-segments (`/huuhoa143/proxy-farm/../x`), userinfo
 * (`https://github.com@evil.example/…`), other hosts, other ports, and look-alike
 * prefixes (`/huuhoa143/proxy-farm-evil`) are all rejected.
 */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'github.com' || url.port !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.pathname === REPO_PATH || url.pathname.startsWith(`${REPO_PATH}/`);
}
