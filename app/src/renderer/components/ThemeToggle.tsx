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
 * Apply the persisted (or system) theme to `<html data-theme>` synchronously,
 * before React's first paint. Called from main.tsx so the boot splash — which
 * renders before <ThemeToggle/> mounts — already shows in the right theme
 * instead of flashing the dark default for a light-theme user.
 */
export function applyInitialTheme(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = loadTheme();
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
