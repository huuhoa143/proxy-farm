import { useEffect, useState } from 'react';
import type { AppStatus } from '../shared/contracts';
import { useTranslation } from 'react-i18next';
import { getProxyFarmApi } from './api';
import { initI18n, changeLanguage } from './i18n';
import { Onboarding } from './components/Onboarding';
import { MainScreen } from './components/MainScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ThemeToggle } from './components/ThemeToggle';
import { LanguageSwitch } from './components/LanguageSwitch';
import { Icon, type IconName } from './ui/Icon';

type Screen = 'onboarding' | 'main' | 'settings';

const api = getProxyFarmApi();
// Initialise synchronously (system-locale guess) so the very first render —
// including this loading screen — already has a working `t()`. The real
// persisted language preference is applied once settings load, below.
initI18n();

const NAV: Array<{ screen: Screen; icon: IconName; labelKey: string }> = [
  { screen: 'main', icon: 'globe', labelKey: 'common.nav.main' },
  { screen: 'onboarding', icon: 'plug', labelKey: 'common.nav.providers' },
  { screen: 'settings', icon: 'gear', labelKey: 'common.nav.settings' },
];

const TITLE: Record<Screen, { title: string; subtitle?: string }> = {
  main: { title: 'main.title' },
  onboarding: { title: 'onboarding.title', subtitle: 'onboarding.subtitle' },
  settings: { title: 'settings.title', subtitle: 'settings.subtitle' },
};

export function App() {
  const { t } = useTranslation();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [status, setStatus] = useState<AppStatus>({ secretsUnavailable: false });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSettings(), api.listProviders(), api.getAppStatus()]).then(([settings, providers, appStatus]) => {
      if (cancelled) return;
      setStatus(appStatus);
      void changeLanguage(settings.language);
      const hasAccount = providers.some((p) => p.accounts.length > 0);
      setScreen(hasAccount ? 'main' : 'onboarding');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (screen === null) {
    return <p className="boot">{t('common.loading')}</p>;
  }

  if (status.engineError) {
    // spec §9/§6.3: a missing or quarantined engine is a clear error screen, not a crash.
    return (
      <div className="engine-error" role="alert" data-testid="engine-error">
        <Icon name="alert" />
        <h1>{t('app.engineErrorTitle')}</h1>
        <p>{t('app.engineErrorBody')}</p>
        <details>
          <summary>{t('app.engineErrorDetails')}</summary>
          <pre>{status.engineError}</pre>
        </details>
      </div>
    );
  }

  const heading = TITLE[screen];

  return (
    <div className="app-shell">
      <nav className="rail" aria-label={t('common.appName') as string}>
        <div className="brand" title={t('common.appName') as string}>
          <Icon name="relay" />
        </div>
        {NAV.map((item) => (
          <button
            key={item.screen}
            className={`rail-btn${screen === item.screen ? ' active' : ''}`}
            aria-current={screen === item.screen ? 'page' : undefined}
            onClick={() => setScreen(item.screen)}
          >
            <Icon name={item.icon} />
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
        <div className="rail-sp" />
        <ThemeToggle />
      </nav>
      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{t(heading.title)}</h1>
            {heading.subtitle && <p>{t(heading.subtitle)}</p>}
          </div>
          <div className="topbar-tools">
            <LanguageSwitch api={api} />
          </div>
        </header>
        {status.secretsUnavailable && (
          <div className="callout warn app-banner" role="status" data-testid="secrets-unavailable">
            <Icon name="alert" />
            <span>{t('app.secretsUnavailable')}</span>
          </div>
        )}
        {status.notice && (
          <div className="callout warn app-banner" role="status" data-testid="app-notice">
            <Icon name="info" />
            <span>{status.notice}</span>
          </div>
        )}
        {screen === 'onboarding' && <Onboarding api={api} onDone={() => setScreen('main')} />}
        {screen === 'main' && <MainScreen api={api} />}
        {screen === 'settings' && <SettingsScreen api={api} />}
      </div>
    </div>
  );
}
