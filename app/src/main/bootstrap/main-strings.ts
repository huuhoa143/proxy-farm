/**
 * The few strings the MAIN process shows itself (native dialogs), read from the same
 * en/vi JSON as the renderer (same approach as tray.ts) so copy never drifts.
 */
import en from '../../renderer/i18n/en.json';
import vi from '../../renderer/i18n/vi.json';
import type { Settings } from '../../shared/contracts';

export type MainLanguage = 'en' | 'vi';

export function resolveMainLanguage(setting: Settings['language'], systemLocale: string): MainLanguage {
  if (setting === 'en' || setting === 'vi') return setting;
  return systemLocale.toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

export function mainStrings(lang: MainLanguage): typeof en.app {
  return (lang === 'vi' ? vi : en).app;
}
