import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderId, Target } from '../../shared/contracts';
import { Flag } from '../ui/Flag';
import { Icon } from '../ui/Icon';
import { countryName } from '../ui/countryName';
import { providerName } from '../ui/providerName';

export interface LocationPickerProps {
  targets: Target[];
  /** Target keys that already have a port — tagged "Running" in the list. */
  runningKeys?: ReadonlySet<string>;
  onStart: (keys: string[]) => void;
  onClose: () => void;
}

interface CountryGroup {
  country: string;
  name: string;
  targets: Target[];
}

function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * Location picker drawer: search, provider filter, countries grouped with
 * flags, multi-select city rows, sticky "Start N" footer.
 */
export function LocationPicker({ targets, runningKeys, onStart, onClose }: LocationPickerProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const language = i18n.language || 'en';

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const providers = useMemo(() => {
    const counts = new Map<ProviderId, number>();
    for (const target of targets) counts.set(target.providerId, (counts.get(target.providerId) ?? 0) + 1);
    return Array.from(counts.entries());
  }, [targets]);

  const groups = useMemo<CountryGroup[]>(() => {
    const q = normalise(query.trim());
    const byCountry = new Map<string, CountryGroup>();
    for (const target of targets) {
      if (provider !== 'all' && target.providerId !== provider) continue;
      const name = countryName(target.country, language);
      if (q) {
        const haystack = normalise(`${name} ${target.country} ${target.city} ${target.label}`);
        if (!haystack.includes(q)) continue;
      }
      let group = byCountry.get(target.country);
      if (!group) {
        group = { country: target.country, name, targets: [] };
        byCountry.set(target.country, group);
      }
      group.targets.push(target);
    }
    const list = Array.from(byCountry.values());
    list.sort((a, b) => a.name.localeCompare(b.name, language));
    for (const group of list) group.targets.sort((a, b) => a.city.localeCompare(b.city, language));
    return list;
  }, [targets, provider, query, language]);

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroup(group: CountryGroup) {
    setPicked((prev) => {
      const next = new Set(prev);
      const all = group.targets.every((tg) => next.has(tg.key));
      for (const tg of group.targets) {
        if (all) next.delete(tg.key);
        else next.add(tg.key);
      }
      return next;
    });
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        data-testid="location-picker"
      >
        <div className="drawer-h">
          <div className="t">
            <h2 id="picker-title">{t('main.picker.title')}</h2>
            <p>{t('main.picker.subtitle')}</p>
          </div>
          <button
            className="iconbtn"
            onClick={onClose}
            aria-label={t('common.close') as string}
            title={t('common.close') as string}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-tools">
          <div className="search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('main.picker.searchPlaceholder') as string}
              aria-label={t('main.picker.searchPlaceholder') as string}
            />
          </div>
          {providers.length > 1 && (
            <div className="seg" role="group" aria-label={t('main.table.provider') as string}>
              <button aria-pressed={provider === 'all'} onClick={() => setProvider('all')}>
                {t('main.picker.allProviders')} <b>{targets.length}</b>
              </button>
              {providers.map(([id, count]) => (
                <button key={id} aria-pressed={provider === id} onClick={() => setProvider(id)}>
                  <span className={`psw ${id}`} />
                  {providerName(id, t)} <b>{count}</b>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="picklist">
          {groups.length === 0 && <p className="pick-empty">{t('main.picker.noResults', { query })}</p>}
          {groups.map((group) => {
            const pickedInGroup = group.targets.filter((tg) => picked.has(tg.key)).length;
            const all = pickedInGroup === group.targets.length;
            return (
              <div className="grp" key={group.country} role="group" aria-label={group.name}>
                <div className="grp-h">
                  <input
                    type="checkbox"
                    className="ck"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = pickedInGroup > 0 && !all;
                    }}
                    onChange={() => toggleGroup(group)}
                    aria-label={t('main.picker.selectCountry', { country: group.name }) as string}
                  />
                  <Flag country={group.country} size="sm" />
                  <span className="nm">{group.name}</span>
                  <span className="n">{t('main.picker.cities', { count: group.targets.length })}</span>
                </div>
                {group.targets.map((target) => {
                  const on = picked.has(target.key);
                  const running = runningKeys?.has(target.key) ?? false;
                  return (
                    <label key={target.key} className={`opt${on ? ' on' : ''}${running ? ' run' : ''}`}>
                      <input type="checkbox" className="ck" checked={on} onChange={() => toggle(target.key)} />
                      <span className="city">{target.city}</span>
                      {running && <span className="pill ok">{t('main.picker.running')}</span>}
                      <span className="prov">
                        <span className={`psw ${target.providerId}`} />
                        {providerName(target.providerId, t)}
                      </span>
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="drawer-f">
          <span className="sum">{t('main.selectedCount', { count: picked.size })}</span>
          {picked.size > 0 && (
            <button className="btn ghost" onClick={() => setPicked(new Set())}>
              {t('main.picker.clear')}
            </button>
          )}
          <button
            className="btn primary"
            disabled={picked.size === 0}
            onClick={() => {
              onStart(Array.from(picked));
              setPicked(new Set());
            }}
          >
            <Icon name="power" />
            {picked.size === 0 ? t('main.start') : t('main.picker.startN', { count: picked.size })}
          </button>
        </div>
      </aside>
    </>
  );
}
