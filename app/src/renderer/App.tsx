import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getProxyFarmApi } from './api';
import { initI18n, changeLanguage } from './i18n';
import { Onboarding } from './components/Onboarding';
import { MainScreen } from './components/MainScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ThemeToggle } from './components/ThemeToggle';

type Screen = 'onboarding' | 'main' | 'settings';

const api = getProxyFarmApi();
// Initialise synchronously (system-locale guess) so the very first render —
// including this loading screen — already has a working `t()`. The real
// persisted language preference is applied once settings load, below.
initI18n();

export function App() {
  const { t } = useTranslation();
  const [screen, setScreen] = useState<Screen | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSettings(), api.listProviders()]).then(([settings, providers]) => {
      if (cancelled) return;
      void changeLanguage(settings.language);
      const hasAccount = providers.some((p) => p.accounts.length > 0);
      setScreen(hasAccount ? 'main' : 'onboarding');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (screen === null) {
    return <p>{t('common.loading')}</p>;
  }

  return (
    <div className="app-shell">
      <nav className="nav">
        <div className="nav-brand">{t('common.appName')}</div>
        <button className={`nav-item${screen === 'main' ? ' active' : ''}`} onClick={() => setScreen('main')}>
          {t('common.nav.main')}
        </button>
        <button className={`nav-item${screen === 'onboarding' ? ' active' : ''}`} onClick={() => setScreen('onboarding')}>
          {t('common.nav.providers')}
        </button>
        <button className={`nav-item${screen === 'settings' ? ' active' : ''}`} onClick={() => setScreen('settings')}>
          {t('common.nav.settings')}
        </button>
        <div style={{ flex: 1 }} />
        <ThemeToggle />
      </nav>
      <div className="main-area">
        {screen === 'onboarding' && <Onboarding api={api} onDone={() => setScreen('main')} />}
        {screen === 'main' && <MainScreen api={api} />}
        {screen === 'settings' && <SettingsScreen api={api} />}
      </div>
    </div>
  );
}
