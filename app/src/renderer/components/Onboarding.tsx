import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi } from '../../shared/contracts';
import { FileCard, HmaCard, SurfsharkCard, ZoogVpnCard } from './OnboardingCards';

export interface OnboardingProps {
  api: ProxyFarmApi;
  onDone: () => void;
}

export function Onboarding({ api, onDone }: OnboardingProps) {
  const { t } = useTranslation();
  const [hmaDetected, setHmaDetected] = useState(false);
  const [hasAnyAccount, setHasAnyAccount] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.listProviders().then((providers) => {
      if (cancelled) return;
      const hma = providers.find((p) => p.id === 'hma');
      setHmaDetected(Boolean(hma?.detected?.found));
      setHasAnyAccount(providers.some((p) => p.accounts.length > 0));
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function markAdded() {
    setHasAnyAccount(true);
  }

  return (
    <div data-testid="onboarding">
      <h1>{t('onboarding.title')}</h1>
      <p>{t('onboarding.subtitle')}</p>
      <div className="provider-cards">
        <HmaCard api={api} detected={hmaDetected} onAdded={markAdded} />
        <ZoogVpnCard api={api} onAdded={markAdded} />
        <SurfsharkCard api={api} onAdded={markAdded} />
        <FileCard api={api} onAdded={markAdded} />
      </div>
      <button className="btn primary" disabled={!hasAnyAccount} onClick={onDone} data-testid="onboarding-continue">
        {t('onboarding.continueToApp')}
      </button>
    </div>
  );
}
