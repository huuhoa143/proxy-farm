import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Target } from '../../shared/contracts';

export interface LocationPickerProps {
  targets: Target[];
  onStart: (keys: string[]) => void;
}

export function LocationPicker({ targets, onStart }: LocationPickerProps) {
  const { t } = useTranslation();
  const [country, setCountry] = useState<string>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const countries = useMemo(() => Array.from(new Set(targets.map((t2) => t2.country))).sort(), [targets]);
  const visible = useMemo(
    () => (country === 'all' ? targets : targets.filter((t2) => t2.country === country)),
    [targets, country],
  );

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div data-testid="location-picker">
      <h2>{t('main.pickLocation')}</h2>
      <select aria-label={t('main.country') as string} value={country} onChange={(e) => setCountry(e.target.value)}>
        <option value="all">{t('main.allCountries')}</option>
        {countries.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <ul>
        {visible.map((target) => (
          <li key={target.key}>
            <label>
              <input type="checkbox" checked={picked.has(target.key)} onChange={() => toggle(target.key)} />
              {target.label}
            </label>
          </li>
        ))}
      </ul>
      <div>{t('main.selectedCount', { count: picked.size })}</div>
      <button
        className="btn primary"
        disabled={picked.size === 0}
        onClick={() => {
          onStart(Array.from(picked));
          setPicked(new Set());
        }}
      >
        {t('main.start')}
      </button>
    </div>
  );
}
