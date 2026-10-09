import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderId, ProxyFarmApi } from '../../shared/contracts';
import { providerName } from '../ui/providerName';
import { Icon } from '../ui/Icon';

export interface ProviderLimitFieldProps {
  api: ProxyFarmApi;
  providerId: ProviderId;
  /** The provider's current limit from `listProviders()` (Ruling C). */
  initialLimit?: number;
}

/**
 * One row of the per-provider port limit list (spec §4.2 "Per-provider port
 * limits"). Starts at the current limit reported by `listProviders()`.
 */
export function ProviderLimitField({ api, providerId, initialLimit }: ProviderLimitFieldProps) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState(initialLimit ?? 0);
  const [touched, setTouched] = useState(false);

  // The limit arrives asynchronously (listProviders); adopt it until the user edits.
  useEffect(() => {
    if (!touched && initialLimit !== undefined) setValue(initialLimit);
  }, [initialLimit, touched]);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const name = providerName(providerId, t);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function save() {
    await api.setLimit(providerId, value);
    setSaved(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1800);
  }

  const inputId = `limit-${providerId}`;
  return (
    <div className="limit-row" data-testid={`provider-limit-${providerId}`}>
      <span className={`pv-avatar pv-${providerId} sm`} aria-hidden="true">
        {providerId === 'file' ? <Icon name="file" /> : name.slice(0, 1)}
      </span>
      <label className="limit-name" htmlFor={inputId}>
        {name}
      </label>
      <input
        id={inputId}
        className="num-input"
        type="number"
        min={0}
        aria-label={t('onboarding.portLimit.fieldLabel', { provider: name }) as string}
        value={value}
        onChange={(e) => {
          setValue(Math.max(0, Number(e.target.value) || 0));
          setTouched(true);
          setSaved(false);
        }}
      />
      <span
        className="limit-hint"
        // Why the provider's default is what it is (`DEFAULT_PORT_LIMITS`), where known.
        title={i18n.exists(`onboarding.portLimit.why.${providerId}`) ? (t(`onboarding.portLimit.why.${providerId}`) as string) : undefined}
      >
        {value === 0 ? t('onboarding.portLimit.unlimited') : t('onboarding.portLimit.ports', { count: value })}
      </span>
      <button className="btn sm" onClick={() => void save()}>
        {t('onboarding.portLimit.save')}
      </button>
      <span className="saved-flag" aria-live="polite">
        {saved && (
          <span data-testid={`provider-limit-saved-${providerId}`}>
            <Icon name="check" />
            {t('common.saved')}
          </span>
        )}
      </span>
    </div>
  );
}
