import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Diagnostics } from '../../shared/contracts';
import { isAllowedExternalUrl, LINKS } from '../../shared/links';
import { createFakeProxyFarmApi } from '../api';
import { formatDiagnostics } from '../diagnostics';
import { initI18n } from '../i18n';
import en from '../i18n/en.json';
import vi_ from '../i18n/vi.json';
import { AboutSection } from './AboutSection';
import { DISCLAIMER_PARAGRAPHS, PRIVACY_POINTS } from './PolicyModals';

beforeAll(() => {
  initI18n('en');
});

function setup() {
  const api = createFakeProxyFarmApi();
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AboutSection api={api} version="1.2.3" />);
  return { api, writeText };
}

describe('AboutSection', () => {
  it('shows the app name, version, license and tagline', () => {
    setup();
    expect(screen.getByTestId('about-version')).toHaveTextContent('v1.2.3');
    expect(screen.getByText('MIT License')).toBeInTheDocument();
    expect(screen.getByText('One VPN subscription, many local proxy ports.')).toBeInTheDocument();
  });

  it('links help, bug, security and docs to the right GitHub pages, opened outside the app', () => {
    setup();
    const expected: Record<string, string> = {
      'about-help': LINKS.discussions,
      'about-bug': LINKS.newIssue,
      'about-security': LINKS.securityAdvisory,
      'about-third-party': LINKS.thirdPartyNotices,
      'about-source': LINKS.source,
      'about-releases': LINKS.releases,
    };
    for (const [testId, href] of Object.entries(expected)) {
      const a = screen.getByTestId(testId);
      expect(a).toHaveAttribute('href', href);
      // target=_blank routes through main's allowlisted setWindowOpenHandler.
      expect(a).toHaveAttribute('target', '_blank');
      expect(isAllowedExternalUrl(href)).toBe(true);
    }
    // No email anywhere: support goes through GitHub only.
    expect(document.body.innerHTML).not.toMatch(/mailto:|@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('opens the privacy summary, with a link to the full policy, and closes it', () => {
    setup();
    fireEvent.click(screen.getByTestId('about-privacy'));
    const modal = screen.getByTestId('privacy-modal');
    expect(modal.querySelectorAll('li')).toHaveLength(PRIVACY_POINTS.length);
    expect(modal).toHaveTextContent('no telemetry');
    expect(screen.getByTestId('privacy-full')).toHaveAttribute('href', LINKS.privacy);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByTestId('privacy-modal')).toBeNull();
  });

  it('opens the full disclaimer, with a link to DISCLAIMER.md', () => {
    setup();
    fireEvent.click(screen.getByTestId('about-disclaimer'));
    const modal = screen.getByTestId('disclaimer-modal');
    expect(modal.querySelectorAll('p')).toHaveLength(DISCLAIMER_PARAGRAPHS.length);
    expect(modal).toHaveTextContent('as is');
    expect(screen.getByTestId('disclaimer-full')).toHaveAttribute('href', LINKS.disclaimer);
  });

  it('copies a diagnostics report without any secret, credential, account name or IP', async () => {
    const { writeText } = setup();
    fireEvent.click(screen.getByTestId('about-diagnostics'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0];
    expect(text).toContain('Proxy Farm diagnostics');
    expect(text).toContain('sing-box: 1.14.2');
    expect(text).toMatch(/hma: 1 account\(s\), \d+ port\(s\)/);
    // The fake backend's proxy credentials, account labels/udid, pinned servers and exit IPs.
    for (const s of ['demo-pass-1234', 'proxyfarm', 'demo@example.com', 'device-demo', 'HMA (this device)', '203.0.113', '192.0.2', 'webunlim', '29001']) {
      expect(text, `diagnostics must not contain ${s}`).not.toContain(s);
    }
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    await waitFor(() => expect(screen.getByTestId('about-diagnostics')).toHaveTextContent('Copied'));
  });

  it('says so when the clipboard is unavailable', async () => {
    const api = createFakeProxyFarmApi();
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    render(<AboutSection api={api} version="1.2.3" />);
    fireEvent.click(screen.getByTestId('about-diagnostics'));
    await waitFor(() => expect(screen.getByTestId('about-diagnostics-failed')).toBeInTheDocument());
  });
});

describe('formatDiagnostics', () => {
  it('reads only the known fields, so smuggled extra properties never reach the report', () => {
    const d = {
      appVersion: '0.1.0',
      os: { platform: 'darwin', release: '23.4.0', arch: 'arm64', hostname: 'robins-mac' },
      versions: { electron: '42.0.1', chrome: '140.0.0.0', node: '22.0.0' },
      singBox: null,
      providers: [
        { id: 'hma', accounts: 2, ports: 3, portStates: { online: 2, failed: 1 }, label: 'me@example.com', exitIp: '198.51.100.7' },
        { id: 'file', accounts: 0, ports: 0, portStates: {} },
      ],
      proxyPass: 'leaked-pass',
    } as unknown as Diagnostics;
    const text = formatDiagnostics(d);
    expect(text).toBe(
      [
        'Proxy Farm diagnostics',
        'App: 0.1.0',
        'OS: darwin 23.4.0 (arm64)',
        'Electron: 42.0.1 | Chrome: 140.0.0.0 | Node: 22.0.0',
        'sing-box: unavailable (engine check failed)',
        'Providers:',
        '  hma: 2 account(s), 3 port(s) (online 2, failed 1)',
        '  file: 0 account(s), 0 port(s)',
      ].join('\n'),
    );
    for (const s of ['robins-mac', 'me@example.com', '198.51.100.7', 'leaked-pass']) expect(text).not.toContain(s);
  });
});

describe('about / privacy / disclaimer copy', () => {
  it('exists in both languages, with no email address', () => {
    for (const section of ['about', 'privacy', 'disclaimer'] as const) {
      expect(Object.keys(vi_[section]).sort()).toEqual(Object.keys(en[section]).sort());
      for (const lang of [en, vi_]) expect(JSON.stringify(lang[section])).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    }
  });
});
