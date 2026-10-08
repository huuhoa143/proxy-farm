import { describe, expect, it } from 'vitest';
import { changeLanguage, initI18n } from './index';

describe('<html lang> follows the UI language', () => {
  it('is set on init and updated on every language change', async () => {
    document.documentElement.lang = '';
    const i18n = initI18n('vi');
    await i18n.loadLanguages('vi'); // init is async in principle; resources are bundled
    expect(document.documentElement.lang).toBe('vi');

    await changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');

    await changeLanguage('vi');
    expect(document.documentElement.lang).toBe('vi');
  });
});
