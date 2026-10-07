import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'proxyfarm.theme';

function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function loadTheme(): Theme {
  if (typeof localStorage === 'undefined') return systemTheme();
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : systemTheme();
}

/**
 * Light/dark toggle (spec §4.2). Not part of `Settings` in contracts.ts — purely
 * a renderer-local, cosmetic preference persisted to localStorage and applied
 * via `document.documentElement.dataset.theme`.
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const label = `${t('common.theme.toggle')} (${theme === 'dark' ? t('common.theme.dark') : t('common.theme.light')})`;
  return (
    <button
      className="rail-icon"
      title={label}
      aria-label={label}
      onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
    </button>
  );
}
