import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { initI18n } from '../i18n';
import { accountLabel } from './accountLabel';

describe('accountLabel', () => {
  beforeAll(() => {
    initI18n('en');
  });
  afterEach(async () => {
    await i18next.changeLanguage('en');
  });

  it('renders the stored HMA device label in the active language', async () => {
    await i18next.changeLanguage('vi');
    expect(accountLabel(i18next.t, 'device …A1B2C3')).toBe('Thiết bị …A1B2C3');
    await i18next.changeLanguage('en');
    expect(accountLabel(i18next.t, 'device …A1B2C3')).toBe('Device …A1B2C3');
  });

  it('renders the stored Surfshark key label in the active language', async () => {
    await i18next.changeLanguage('vi');
    expect(accountLabel(i18next.t, 'key …xyz12=')).toBe('Khoá …xyz12=');
  });

  it('shows user-derived labels verbatim', () => {
    expect(accountLabel(i18next.t, 'someone@example.com')).toBe('someone@example.com');
    expect(accountLabel(i18next.t, 'vpn.example.net:1194')).toBe('vpn.example.net:1194');
    expect(accountLabel(i18next.t, 'my device …x')).toBe('my device …x');
  });
});
