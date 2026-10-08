import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import vi from './vi.json';
import type { Settings } from '../../shared/contracts';

export const resources = {
  en: { translation: en },
  vi: { translation: vi },
} as const;

export type UiLanguage = 'en' | 'vi';

/**
 * Settings.language is 'en' | 'vi' | 'system'. Vietnamese is the app's default
 * language: 'system' resolves to English only when the host's reported locale
 * (navigator.language in the renderer) is explicitly English, and to
 * Vietnamese for everything else (a Vietnamese or unrecognised locale).
 */
export function resolveLanguage(setting: Settings['language'], systemLocale = detectSystemLocale()): UiLanguage {
  if (setting === 'en' || setting === 'vi') {
    return setting;
  }
  return systemLocale.toLowerCase().startsWith('en') ? 'en' : 'vi';
}

function detectSystemLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'vi';
}

let initialized = false;

/** Initialise the shared i18next instance once. Safe to call repeatedly. */
export function initI18n(initialSetting: Settings['language'] = 'vi'): typeof i18next {
  if (!initialized) {
    void i18next.use(initReactI18next).init({
      resources,
      lng: resolveLanguage(initialSetting),
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    initialized = true;
  }
  return i18next;
}

export function changeLanguage(setting: Settings['language']): Promise<unknown> {
  return i18next.changeLanguage(resolveLanguage(setting));
}

export default i18next;
