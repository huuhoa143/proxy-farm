import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderId, ProxyFarmApi } from '../../shared/contracts';
import { FileCard, HmaCard, SurfsharkCard, ZoogVpnCard, type HmaDetected } from './OnboardingCards';

export interface OnboardingProps {
  api: ProxyFarmApi;
  onDone: () => void;
}

const PROVIDER_IDS: ProviderId[] = ['hma', 'zoogvpn', 'surfshark', 'file'];

function ProviderLimitField({ api, providerId }: { api: ProxyFarmApi; providerId: ProviderId }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(0);
  const [saved, setSaved] = useState(false);

  async function save() {
    await api.setLimit(providerId, value);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div data-testid={`provider-limit-${providerId}`}>
      <label>
        {t('onboarding.portLimit.label')} — {providerId}
        <input
          type="number"
          min={0}
          aria-label={`${t('onboarding.portLimit.label')} ${providerId}`}
          value={value}
          onChange={(e) => setValue(Math.max(0, Number(e.target.value) || 0))}
        />
      </label>
      <span className="guidance">{t('onboarding.portLimit.unlimited')}</span>
      <button className="btn ghost" onClick={() => void save()}>
        {t('onboarding.portLimit.save')}
      </button>
      {saved && <span data-testid={`provider-limit-saved-${providerId}`}>{t('common.saved')}</span>}
    </div>
  );
}

export function Onboarding({ api, onDone }: OnboardingProps) {
  const { t } = useTranslation();
  const [hmaDetected, setHmaDetected] = useState<HmaDetected | undefined>(undefined);
  const [hasAnyAccount, setHasAnyAccount] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.listProviders().then((providers) => {
      if (cancelled) return;
      const hma = providers.find((p) => p.id === 'hma');
      setHmaDetected(hma?.detected);
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
      <section data-testid="provider-limits">
        {PROVIDER_IDS.map((id) => (
          <ProviderLimitField key={id} api={api} providerId={id} />
        ))}
      </section>
      <button className="btn primary" disabled={!hasAnyAccount} onClick={onDone} data-testid="onboarding-continue">
        {t('onboarding.continueToApp')}
      </button>
    </div>
  );
}
