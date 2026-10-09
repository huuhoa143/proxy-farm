import { useEffect, useState } from 'react';
import { DISCLAIMER_NOTICE_VERSION, type AppStatus } from '../shared/contracts';
import { useTranslation } from 'react-i18next';
import { getProxyFarmApi } from './api';
import { initI18n, changeLanguage } from './i18n';
import { Onboarding } from './components/Onboarding';
import { MainScreen } from './components/MainScreen';
import { CheckStoreProvider, createCheckStore } from './checkStore';
import { SettingsScreen } from './components/SettingsScreen';
import { FirstRunNotice } from './components/FirstRunNotice';
import { ThemeToggle } from './components/ThemeToggle';
import { LanguageSwitch } from './components/LanguageSwitch';
import { Icon, type IconName } from './ui/Icon';

type Screen = 'onboarding' | 'main' | 'settings';

const api = getProxyFarmApi();
// Check results and a running Check all outlive a switch away from the Ports screen.
const checkStore = createCheckStore();
// Initialise synchronously (Vietnamese, the default) so the very first render —
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
  const [needsNotice, setNeedsNotice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let settled = false;

    // Safety net: if a boot IPC call hangs (never resolves nor rejects), still
    // land on a usable screen instead of an endless loading state (which, on
    // the dark theme, reads as a permanently black window).
    const bootTimeout = setTimeout(() => {
      if (cancelled || settled) return;
      setScreen('onboarding');
    }, 8000);

    // allSettled (not all): one failing IPC call must not strand the whole app
    // on the loading screen. Each result is applied independently; whatever
    // resolved is used, whatever rejected falls back to a safe default.
    void Promise.allSettled([api.getSettings(), api.listProviders(), api.getAppStatus()]).then((results) => {
      if (cancelled) return;
      settled = true;
      clearTimeout(bootTimeout);
      const [settingsR, providersR, statusR] = results;
      if (statusR.status === 'fulfilled') setStatus(statusR.value);
      if (settingsR.status === 'fulfilled') {
        void changeLanguage(settingsR.value.language);
        // Not `<`: a missing field (an older main process) must still show the notice.
        setNeedsNotice(!(settingsR.value.acknowledgedDisclaimer >= DISCLAIMER_NOTICE_VERSION));
      }
      const hasAccount = providersR.status === 'fulfilled' && providersR.value.some((p) => p.accounts.length > 0);
      setScreen(hasAccount ? 'main' : 'onboarding');
    });

    return () => {
      cancelled = true;
      clearTimeout(bootTimeout);
    };
  }, []);

  if (screen === null) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <div className="boot-brand">
          <Icon name="relay" />
        </div>
        <div className="boot-name">{t('common.appName')}</div>
        <div className="boot-spinner" aria-hidden="true" />
        <p className="boot-msg">{t('common.loading')}</p>
      </div>
    );
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
        {needsNotice && <FirstRunNotice api={api} onAcknowledged={() => setNeedsNotice(false)} />}
        {screen === 'onboarding' && <Onboarding api={api} onDone={() => setScreen('main')} />}
        {screen === 'main' && (
          <CheckStoreProvider value={checkStore}>
            <MainScreen api={api} />
          </CheckStoreProvider>
        )}
        {screen === 'settings' && <SettingsScreen api={api} />}
      </div>
    </div>
  );
}
