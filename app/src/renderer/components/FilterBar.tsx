import { useTranslation } from 'react-i18next';
import type { ProviderId } from '../../shared/contracts';
import { STATUS_FILTERS, type PortFilter } from '../portFilter';
import { Icon } from '../ui/Icon';
import { providerName } from '../ui/providerName';

export interface FilterBarProps {
  filter: PortFilter;
  onChange: (filter: PortFilter) => void;
  /** Ports per status chip, under the current provider and search. */
  counts: Record<PortFilter['status'], number>;
  /** Providers that have ports. */
  providers: readonly ProviderId[];
}

/** Status chips, provider and search above the port table (spec §4.1 "Filters"). */
export function FilterBar({ filter, onChange, counts, providers }: FilterBarProps) {
  const { t } = useTranslation();
  // A remembered provider with no ports left stays listed, so the filter never hides itself.
  const options = filter.provider !== 'all' && !providers.includes(filter.provider) ? [...providers, filter.provider] : providers;
  return (
    <div className="filterbar" role="search" aria-label={t('main.filter.label') as string} data-testid="filter-bar">
      <div className="seg" role="group" aria-label={t('main.filter.statusLabel') as string}>
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={filter.status === status}
            onClick={() => onChange({ ...filter, status })}
            data-testid={`filter-status-${status}`}
          >
            {status !== 'all' && <span className={`fdot ${status}`} aria-hidden="true" />}
            {t(`main.filter.status.${status}`)} <b>{counts[status]}</b>
          </button>
        ))}
      </div>
      {options.length > 1 && (
        <select
          className="filter-provider"
          aria-label={t('main.filter.provider') as string}
          value={filter.provider}
          onChange={(e) => onChange({ ...filter, provider: e.target.value as PortFilter['provider'] })}
          data-testid="filter-provider"
        >
          <option value="all">{t('main.filter.allProviders')}</option>
          {options.map((id) => (
            <option key={id} value={id}>
              {providerName(id, t)}
            </option>
          ))}
        </select>
      )}
      <div className="search filter-search">
        <Icon name="search" />
        <input
          type="search"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          placeholder={t('main.filter.searchPlaceholder') as string}
          aria-label={t('main.filter.searchPlaceholder') as string}
          data-testid="filter-search"
        />
      </div>
    </div>
  );
}
