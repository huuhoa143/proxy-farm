import { describe, expect, it, vi } from 'vitest';
import { isAllowedExternalUrl, LINKS } from '../../shared/links';
import { openExternalIfAllowed } from './external-links';

describe('external link allowlist', () => {
  it('allows every link the app itself shows', () => {
    for (const url of Object.values(LINKS)) expect(isAllowedExternalUrl(url), url).toBe(true);
    // The updater's manual-download fallback.
    expect(isAllowedExternalUrl('https://github.com/huuhoa143/proxy-farm/releases/latest')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/huuhoa143/proxy-farm')).toBe(true);
  });

  it.each([
    ['plain http', 'http://github.com/huuhoa143/proxy-farm'],
    ['another repo', 'https://github.com/huuhoa143/other'],
    ['a look-alike repo name', 'https://github.com/huuhoa143/proxy-farm-evil'],
    ['another host', 'https://evil.example/huuhoa143/proxy-farm'],
    ['a subdomain', 'https://gist.github.com/huuhoa143/proxy-farm'],
    ['a host suffix', 'https://github.com.evil.example/huuhoa143/proxy-farm'],
    ['userinfo tricks', 'https://github.com@evil.example/huuhoa143/proxy-farm'],
    ['credentials on github', 'https://user:pass@github.com/huuhoa143/proxy-farm'],
    ['a non-default port', 'https://github.com:8443/huuhoa143/proxy-farm'],
    ['dot-segments out of the repo', 'https://github.com/huuhoa143/proxy-farm/../../evil/repo'],
    ['encoded dot-segments', 'https://github.com/huuhoa143/proxy-farm/%2e%2e/%2e%2e/evil'],
    ['file scheme', 'file:///etc/passwd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['a custom scheme', 'smb://github.com/huuhoa143/proxy-farm'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it('openExternalIfAllowed opens only allowlisted URLs and never logs a blocked URL in full', () => {
    const open = vi.fn(async () => undefined);
    const log = vi.fn();
    expect(openExternalIfAllowed(LINKS.discussions, open, log)).toBe(true);
    expect(open).toHaveBeenCalledWith(LINKS.discussions);

    expect(openExternalIfAllowed('https://evil.example/path?token=secret', open, log)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain('secret');
  });
});
