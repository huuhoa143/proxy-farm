/**
 * The few strings the MAIN process shows itself (native dialogs), read from the same
 * en/vi JSON as the renderer (same approach as tray.ts) so copy never drifts.
 */
import en from '../../renderer/i18n/en.json';
import vi from '../../renderer/i18n/vi.json';
import type { Settings } from '../../shared/contracts';

export type MainLanguage = 'en' | 'vi';

/** Same rule as the renderer's `resolveLanguage`: an explicit choice wins; 'system'
 * follows the OS only when it is English, and is Vietnamese otherwise (the default). */
export function resolveMainLanguage(setting: Settings['language'], systemLocale: string): MainLanguage {
  if (setting === 'en' || setting === 'vi') return setting;
  return systemLocale.toLowerCase().startsWith('en') ? 'en' : 'vi';
}

export function mainStrings(lang: MainLanguage): typeof en.app {
  return (lang === 'vi' ? vi : en).app;
}
