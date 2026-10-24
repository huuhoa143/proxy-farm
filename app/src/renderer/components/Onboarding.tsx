import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ENABLED_PROVIDERS, type Account, type ProviderId, type ProxyFarmApi } from '../../shared/contracts';
import { ExpressVpnCard, FileCard, HmaCard, NordVpnCard, SurfsharkCard, ZoogVpnCard } from './OnboardingCards';
import { Icon } from '../ui/Icon';

export interface OnboardingProps {
  api: ProxyFarmApi;
  onDone: () => void;
}

const PROVIDER_IDS: ProviderId[] = ['hma', 'zoogvpn', 'surfshark', 'nordvpn', 'expressvpn', 'file'];
type Counts = Record<ProviderId, number>;
const NO_ACCOUNTS: Counts = { hma: 0, zoogvpn: 0, surfshark: 0, nordvpn: 0, expressvpn: 0, file: 0 };

export function Onboarding({ api, onDone }: OnboardingProps) {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Counts>(NO_ACCOUNTS);
  const [accountsByProvider, setAccountsByProvider] = useState<Partial<Record<ProviderId, Account[]>>>({});
  const accountsOf = (id: ProviderId): Account[] => accountsByProvider[id] ?? [];

  async function refresh(cancelled: () => boolean = () => false) {
    const providers = await api.listProviders();
    if (cancelled()) return;
    const next = { ...NO_ACCOUNTS };
    const byProvider: Partial<Record<ProviderId, Account[]>> = {};
    for (const p of providers) {
      next[p.id] = p.accounts.length;
      byProvider[p.id] = p.accounts;
    }
    setCounts(next);
    setAccountsByProvider(byProvider);
  }

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);


  function markAdded() {
    void refresh();
  }

  const total = PROVIDER_IDS.reduce((sum, id) => sum + counts[id], 0);
  const hasAnyAccount = total > 0;

  return (
    <div className="screen" data-testid="onboarding">
      <div className="provider-cards">
        {ENABLED_PROVIDERS.includes('hma') && <HmaCard api={api} onAdded={markAdded} accountCount={counts.hma} accounts={accountsOf('hma')} />}
        {ENABLED_PROVIDERS.includes('zoogvpn') && <ZoogVpnCard api={api} onAdded={markAdded} accountCount={counts.zoogvpn} />}
        {ENABLED_PROVIDERS.includes('surfshark') && <SurfsharkCard api={api} onAdded={markAdded} accountCount={counts.surfshark} accounts={accountsOf('surfshark')} />}
        {ENABLED_PROVIDERS.includes('nordvpn') && <NordVpnCard api={api} onAdded={markAdded} accountCount={counts.nordvpn} accounts={accountsOf('nordvpn')} />}
        {ENABLED_PROVIDERS.includes('expressvpn') && <ExpressVpnCard api={api} onAdded={markAdded} accountCount={counts.expressvpn} />}
        {ENABLED_PROVIDERS.includes('file') && <FileCard api={api} onAdded={markAdded} accountCount={counts.file} />}
      </div>
      <div className={`onb-footer${hasAnyAccount ? ' ready' : ''}`}>
        <span className="sum">
          {hasAnyAccount ? t('onboarding.status.total', { count: total }) : t('onboarding.continueHint')}
        </span>
        <button className="btn primary" disabled={!hasAnyAccount} onClick={onDone} data-testid="onboarding-continue">
          {t('onboarding.continueToApp')}
          <Icon name="chevron" />
        </button>
      </div>
    </div>
  );
}
