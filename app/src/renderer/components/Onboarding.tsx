import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderId, ProxyFarmApi } from '../../shared/contracts';
import { ExpressVpnCard, FileCard, HmaCard, NordVpnCard, SurfsharkCard, ZoogVpnCard, type HmaDetected } from './OnboardingCards';
import { ProviderLimitField } from './ProviderLimitField';
import { Icon } from '../ui/Icon';

export interface OnboardingProps {
  api: ProxyFarmApi;
  onDone: () => void;
}

const PROVIDER_IDS: ProviderId[] = ['hma', 'zoogvpn', 'surfshark', 'nordvpn', 'expressvpn', 'file'];
type Counts = Record<ProviderId, number>;
const HMA_WATCH_MS = 3000;
const NO_ACCOUNTS: Counts = { hma: 0, zoogvpn: 0, surfshark: 0, nordvpn: 0, expressvpn: 0, file: 0 };

export function Onboarding({ api, onDone }: OnboardingProps) {
  const { t } = useTranslation();
  const [hmaDetected, setHmaDetected] = useState<HmaDetected | undefined>(undefined);
  const [counts, setCounts] = useState<Counts>(NO_ACCOUNTS);
  const [limits, setLimits] = useState<Partial<Record<ProviderId, number>>>({});

  async function refresh(cancelled: () => boolean = () => false) {
    const providers = await api.listProviders();
    if (cancelled()) return;
    const hma = providers.find((p) => p.id === 'hma');
    setHmaDetected(hma?.detected);
    const next = { ...NO_ACCOUNTS };
    for (const p of providers) next[p.id] = p.accounts.length;
    setCounts(next);
    setLimits(Object.fromEntries(providers.map((p) => [p.id, p.limit])));
  }

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // spec §4.1: while HMA isn't found, keep watching so the card flips to
  // "found" by itself once the user installs/signs in to HMA.
  const hmaFound = hmaDetected?.found ?? false;
  useEffect(() => {
    if (hmaFound) return undefined;
    let cancelled = false;
    const timer = setInterval(() => void refresh(() => cancelled), HMA_WATCH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, hmaFound]);

  function markAdded() {
    void refresh();
  }

  const total = PROVIDER_IDS.reduce((sum, id) => sum + counts[id], 0);
  const hasAnyAccount = total > 0;

  return (
    <div className="screen" data-testid="onboarding">
      <div className="provider-cards">
        <HmaCard api={api} detected={hmaDetected} onAdded={markAdded} accountCount={counts.hma} />
        <ZoogVpnCard api={api} onAdded={markAdded} accountCount={counts.zoogvpn} />
        <SurfsharkCard api={api} onAdded={markAdded} accountCount={counts.surfshark} />
        <NordVpnCard api={api} onAdded={markAdded} accountCount={counts.nordvpn} />
        <ExpressVpnCard api={api} onAdded={markAdded} accountCount={counts.expressvpn} />
        <FileCard api={api} onAdded={markAdded} accountCount={counts.file} />
      </div>
      {/* Port limits only make sense once at least one provider is connected —
          keep them out of the first-run "add a provider" step (they stay
          reachable here afterwards and from the Providers screen). */}
      {hasAnyAccount && (
        <section className="panel" data-testid="provider-limits" aria-labelledby="limits-title">
          <div className="panel-h">
            <h2 id="limits-title">
              <Icon name="network" />
              {t('onboarding.portLimit.title')}
            </h2>
            <p>{t('onboarding.portLimit.note')}</p>
          </div>
          <div className="limit-list">
            {PROVIDER_IDS.map((id) => (
              <ProviderLimitField key={id} api={api} providerId={id} initialLimit={limits[id]} />
            ))}
          </div>
        </section>
      )}
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
