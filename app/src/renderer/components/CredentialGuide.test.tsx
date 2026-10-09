import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CredentialGuide } from './CredentialGuide';
import { ExpressVpnCard, NordVpnCard, SurfsharkCard } from './OnboardingCards';
import { createFakeProxyFarmApi } from '../api';
import { initI18n } from '../i18n';
import i18next from 'i18next';
import { isAllowedExternalUrl, PROVIDER_LINKS } from '../../shared/links';

beforeAll(() => {
  initI18n('en');
});

describe('CredentialGuide', () => {
  it('is collapsed under its title, and lists the steps in order when opened', () => {
    render(
      <CredentialGuide
        title="How to get it"
        steps={['Sign in', 'Open the page', 'Copy it']}
        notes={['Not the email.']}
        link={{ href: PROVIDER_LINKS.expressvpn, label: 'Open the page' }}
        testId="guide"
      />,
    );
    const guide = screen.getByTestId('guide');
    expect(guide.tagName).toBe('DETAILS');
    expect(guide).not.toHaveAttribute('open');
    fireEvent.click(within(guide).getByText('How to get it'));
    expect(guide).toHaveAttribute('open');
    const items = within(guide).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Sign in', 'Open the page', 'Copy it']);
    expect(within(guide).getByText('Not the email.')).toBeInTheDocument();
  });

  it('opens its link in the system browser: a new-window link main hands to the OS, and on the allowlist', () => {
    render(<CredentialGuide title="t" steps={['a']} link={{ href: PROVIDER_LINKS.nordvpn, label: 'Open Nord Account' }} testId="guide" />);
    const link = screen.getByRole('link', { name: /Open Nord Account/ });
    expect(link).toHaveAttribute('href', PROVIDER_LINKS.nordvpn);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(isAllowedExternalUrl(link.getAttribute('href')!)).toBe(true);
  });
});

describe('credential guides on the add-account cards', () => {
  it.each([
    ['expressvpn', () => <ExpressVpnCard api={createFakeProxyFarmApi()} onAdded={() => {}} />, 4],
    ['nordvpn', () => <NordVpnCard api={createFakeProxyFarmApi()} onAdded={() => {}} />, 4],
    ['surfshark', () => <SurfsharkCard api={createFakeProxyFarmApi()} onAdded={() => {}} />, 5],
  ] as const)('%s: numbered steps and a link to its account page', (id, card, count) => {
    render(card());
    const guide = screen.getByTestId(`${id}-guide`);
    expect(within(guide).getAllByRole('listitem')).toHaveLength(count);
    expect(within(guide).getByRole('link')).toHaveAttribute('href', PROVIDER_LINKS[id]);
  });

  it('ExpressVPN says it is the manual-configuration login, not the email or the activation code', () => {
    render(<ExpressVpnCard api={createFakeProxyFarmApi()} onAdded={() => {}} />);
    const text = screen.getByTestId('expressvpn-guide').textContent ?? '';
    expect(text).toMatch(/Manual configuration/);
    expect(text).toMatch(/activation code/);
  });

  it('every guide string exists in Vietnamese too', async () => {
    const en = i18next.getResourceBundle('en', 'translation') as { onboarding: { providers: Record<string, { guide?: Record<string, string> }> } };
    const vi = i18next.getResourceBundle('vi', 'translation') as typeof en;
    for (const id of ['expressvpn', 'nordvpn', 'surfshark']) {
      const keys = Object.keys(en.onboarding.providers[id].guide ?? {});
      expect(keys.length).toBeGreaterThan(3);
      expect(Object.keys(vi.onboarding.providers[id].guide ?? {}).sort()).toEqual(keys.sort());
    }
  });
});
