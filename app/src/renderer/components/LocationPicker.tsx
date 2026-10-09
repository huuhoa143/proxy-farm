import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderId, Target } from '../../shared/contracts';
import { Flag } from '../ui/Flag';
import { Icon } from '../ui/Icon';
import { countryName } from '../ui/countryName';
import { isCountryWide, locationName } from '../ui/locationName';
import { providerName } from '../ui/providerName';
import { useModalFocusTrap } from '../ui/useModalFocusTrap';
import { normaliseSearch } from '../ui/searchText';
import { addableCount } from '../portGroups';

/** "Add `count` ports to this location" (spec §4.1, §6.8). */
export interface PortRequest {
  locationKey: string;
  count: number;
}

export interface LocationPickerProps {
  targets: Target[];
  /** Ports each location already has (location key → count), shown as a tag. */
  portCounts?: ReadonlyMap<string, number>;
  /** Ports each provider may still add under its limit; a missing provider is unlimited. */
  remaining?: Partial<Record<ProviderId, number>>;
  onSubmit: (requests: PortRequest[]) => void;
  onClose: () => void;
}

interface CountryGroup {
  country: string;
  name: string;
  targets: Target[];
}

/**
 * Location picker drawer: search, provider filter, countries grouped with
 * flags, multi-select city rows. A picked city gets a quantity stepper
 * (default 1, max = its free servers, capped by what the provider's port
 * limit still allows across every picked city); the sticky footer adds them.
 */
export function LocationPicker({ targets, portCounts, remaining = {}, onSubmit, onClose }: LocationPickerProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  // Picked location key → how many ports to add there.
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const language = i18n.language || 'en';

  useModalFocusTrap(drawerRef, onClose);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const providers = useMemo(() => {
    const counts = new Map<ProviderId, number>();
    for (const target of targets) counts.set(target.providerId, (counts.get(target.providerId) ?? 0) + 1);
    return Array.from(counts.entries());
  }, [targets]);

  const groups = useMemo<CountryGroup[]>(() => {
    const q = normaliseSearch(query.trim());
    const byCountry = new Map<string, CountryGroup>();
    for (const target of targets) {
      if (provider !== 'all' && target.providerId !== provider) continue;
      const name = countryName(target.country, language);
      if (q) {
        const haystack = normaliseSearch(`${name} ${target.country} ${target.city} ${locationName(target, language)} ${target.label}`);
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
    for (const group of list) group.targets.sort((a, b) => locationName(a, language).localeCompare(locationName(b, language), language));
    return list;
  }, [targets, provider, query, language]);

  const targetByKey = useMemo(() => new Map(targets.map((tg) => [tg.key, tg])), [targets]);

  /** Max ports for `target` given what the other picks of its provider already use. */
  function maxFor(target: Target, picks: ReadonlyMap<string, number> = picked): number {
    let max = addableCount(target, {});
    const cap = remaining[target.providerId];
    if (cap !== undefined) {
      let usedElsewhere = 0;
      for (const [key, count] of picks) {
        if (key !== target.key && targetByKey.get(key)?.providerId === target.providerId) usedElsewhere += count;
      }
      max = Math.min(max, cap - usedElsewhere);
    }
    return Math.max(0, max);
  }

  function toggle(target: Target) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(target.key)) next.delete(target.key);
      else if (maxFor(target, prev) > 0) next.set(target.key, 1);
      return next;
    });
  }

  function setCount(target: Target, count: number) {
    setPicked((prev) => {
      if (!prev.has(target.key)) return prev;
      const next = new Map(prev);
      next.set(target.key, Math.max(1, Math.min(maxFor(target, prev), Math.round(count) || 1)));
      return next;
    });
  }

  function unpick(key: string) {
    setPicked((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  function toggleGroup(group: CountryGroup) {
    setPicked((prev) => {
      const next = new Map(prev);
      const available = group.targets.filter((tg) => next.has(tg.key) || maxFor(tg, next) > 0);
      const all = available.length > 0 && available.every((tg) => next.has(tg.key));
      for (const tg of available) {
        if (all) next.delete(tg.key);
        else if (!next.has(tg.key) && maxFor(tg, next) > 0) next.set(tg.key, 1);
      }
      return next;
    });
  }

  const totalPorts = Array.from(picked.values()).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        data-testid="location-picker"
        ref={drawerRef}
        tabIndex={-1}
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
          {picked.size > 0 && (
            // Every pick stays visible (and removable) here, even when a search
            // or provider filter hides its row — the footer counts them all.
            <ul className="pick-chips" aria-label={t('main.picker.picked') as string} data-testid="picked-chips">
              {Array.from(picked, ([key, count]) => {
                const target = targetByKey.get(key);
                if (!target) return null;
                return (
                  <li key={key} className="pick-chip" data-testid={`picked-${key}`}>
                    <Flag country={target.country} size="sm" />
                    <span
                      className="pick-chip-t"
                      title={isCountryWide(target, language) ? locationName(target, language) : `${locationName(target, language)} · ${countryName(target.country, language)}`}
                    >
                      {locationName(target, language)}
                    </span>
                    {count > 1 && <b>×{count}</b>}
                    <button
                      type="button"
                      aria-label={t('main.picker.unpick', { location: locationName(target, language) }) as string}
                      title={t('main.picker.unpick', { location: locationName(target, language) }) as string}
                      onClick={() => unpick(key)}
                    >
                      <Icon name="x" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="picklist">
          {groups.length === 0 && <p className="pick-empty">{t('main.picker.noResults', { query })}</p>}
          {groups.map((group) => {
            const pickedInGroup = group.targets.filter((tg) => picked.has(tg.key)).length;
            const pickable = group.targets.filter((tg) => picked.has(tg.key) || maxFor(tg) > 0).length;
            const all = pickable > 0 && pickedInGroup === pickable;
            return (
              <div className="grp" key={group.country} role="group" aria-label={group.name}>
                <div className="grp-h">
                  <input
                    type="checkbox"
                    className="ck"
                    checked={all}
                    disabled={pickable === 0}
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
                  const count = picked.get(target.key);
                  const on = count !== undefined;
                  const have = portCounts?.get(target.key) ?? 0;
                  const max = maxFor(target);
                  const free = target.freeServers ?? target.servers.length;
                  // Every server refused every account of the provider (spec §6.8).
                  const notInPlan = target.notInPlan === true;
                  const unavailable = notInPlan || (!on && max === 0);
                  const unavailableLabel = notInPlan
                    ? t('main.picker.notInPlan')
                    : free === 0
                      ? t('main.picker.noFree')
                      : t('main.picker.limitReached');
                  const notInPlanHint = notInPlan ? (t('main.picker.notInPlanHint', { provider: providerName(target.providerId, t) }) as string) : undefined;
                  // A country-wide location is named after the country, in the UI language.
                  const name = locationName(target, language);
                  return (
                    <div
                      key={target.key}
                      className={`opt${on ? ' on' : ''}${have ? ' run' : ''}${unavailable ? ' off' : ''}${notInPlan ? ' not-in-plan' : ''}`}
                      data-testid={`pick-${target.key}`}
                      title={notInPlanHint}
                    >
                      <label className="opt-main">
                        <input
                          type="checkbox"
                          className="ck"
                          checked={on && !notInPlan}
                          disabled={unavailable}
                          onChange={() => toggle(target)}
                        />
                        <span className="city">
                          {name}
                          <small className="pool">
                            {unavailable
                              ? unavailableLabel
                              : t('main.picker.servers', { count: target.servers.length, free })}
                          </small>
                        </span>
                        {target.virtualLocation && (
                          <span
                            className="pill virt"
                            title={t('main.virtualLocationHint', { provider: providerName(target.providerId, t) }) as string}
                            data-testid={`virtual-${target.key}`}
                          >
                            {t('main.virtualLocation')}
                          </span>
                        )}
                        {have > 0 && <span className="pill ok">{t('main.picker.portsHere', { count: have })}</span>}
                        {!on && (
                          <span className="prov">
                            <span className={`psw ${target.providerId}`} />
                            {providerName(target.providerId, t)}
                          </span>
                        )}
                      </label>
                      {notInPlan && (
                        // Shown, but nothing to step: no port can be added here.
                        <div className="stepper is-disabled" role="group" aria-disabled="true" aria-label={notInPlanHint} title={notInPlanHint}>
                          <button type="button" disabled aria-label={t('main.picker.fewer', { location: name }) as string}>
                            −
                          </button>
                          <input type="number" value={0} disabled readOnly aria-label={t('main.picker.qty', { location: name }) as string} />
                          <button type="button" disabled aria-label={t('main.picker.more', { location: name }) as string}>
                            +
                          </button>
                        </div>
                      )}
                      {on && !notInPlan && (
                        <div
                          className="stepper"
                          role="group"
                          aria-label={t('main.picker.qty', { location: name }) as string}
                          title={t('main.picker.maxHint', { max }) as string}
                        >
                          <button
                            type="button"
                            aria-label={t('main.picker.fewer', { location: name }) as string}
                            disabled={count <= 1}
                            onClick={() => setCount(target, count - 1)}
                          >
                            −
                          </button>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={max}
                            value={count}
                            aria-label={t('main.picker.qty', { location: name }) as string}
                            onChange={(e) => setCount(target, Number(e.target.value))}
                          />
                          <button
                            type="button"
                            aria-label={t('main.picker.more', { location: name }) as string}
                            disabled={count >= max}
                            onClick={() => setCount(target, count + 1)}
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="drawer-f">
          <span className="sum">{t('main.selectedCount', { count: picked.size })}</span>
          {picked.size > 0 && (
            <button className="btn ghost" onClick={() => setPicked(new Map())}>
              {t('main.picker.clear')}
            </button>
          )}
          <button
            className="btn primary"
            disabled={picked.size === 0}
            onClick={() => {
              onSubmit(Array.from(picked, ([locationKey, count]) => ({ locationKey, count })));
              setPicked(new Map());
            }}
            data-testid="picker-submit"
          >
            <Icon name="plus" />
            {picked.size === 0 ? t('main.group.addPort') : t('main.picker.addN', { count: totalPorts })}
          </button>
        </div>
      </aside>
    </>
  );
}
