import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EXIT_IP_MODELS, type PortRow, type ProviderId, type ProxyFarmApi, type Target } from '../../shared/contracts';
import { describePortState, isTerminalFailure } from '../portStateView';
import { addPortBlock, groupPorts, portNumber, remainingByProvider, type PortGroup } from '../portGroups';
import { StatusDot } from './StatusDot';
import { PortDetailsDrawer } from './PortDetailsDrawer';
import { ChangeIpMenu } from './ChangeIpMenu';
import { Flag } from '../ui/Flag';
import { Icon } from '../ui/Icon';
import { countryName } from '../ui/countryName';
import { exitCountry, type ExitCountryView } from '../ui/exitCountry';
import { locationName } from '../ui/locationName';
import { providerName } from '../ui/providerName';

export interface PortTableProps {
  rows: PortRow[];
  selectedKeys: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  onToggleSelectAll: () => void;
  onCopy: (row: PortRow) => void;
  /** Change IP (spec §6.5); `toServer` set when the user picked a server from the menu. */
  onRotate: (row: PortRow, toServer?: string) => void;
  onStop?: (row: PortRow) => void;
  onRemove?: (row: PortRow) => void;
  onMovePort?: (row: PortRow) => void;
  /** The real/fake ProxyFarmApi, used by the per-row Details drawer (logs/test/auto-rotate). */
  api: ProxyFarmApi;
  /** Ephemeral rotate-result notes (e.g. "Exit IP changed: … → …"), keyed by row.key. */
  notes?: Record<string, string>;
  /** Row whose address was just copied (shows a check in its chip). */
  copiedKey?: string | null;
  /** Locations from `listTargets` (pool size, free servers) for the group headers. */
  targets?: readonly Target[];
  /** Provider port limits (0 / missing = unlimited), to disable "+ Add port" at the limit. */
  limits?: Partial<Record<ProviderId, number>>;
  /** "+ Add port" on a group header: add one port to that location. */
  onAddPort?: (locationKey: string) => void;
  /** Select / deselect every port of a group. */
  onSelectGroup?: (keys: string[], select: boolean) => void;
  /** Ports with a Change IP in flight. */
  rotatingKeys?: ReadonlySet<string>;
}

const COLLAPSED_STORAGE_KEY = 'proxyfarm.collapsedGroups';

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    // Storage unavailable (private mode / quota): collapsing still works for this session.
  }
}

/** Collapsed groups, remembered across launches (spec §4.1). */
function useCollapsedGroups(): [ReadonlySet<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }
  return [collapsed, toggle];
}

/** m:ss (or h:mm:ss) for countdowns longer than a minute. */
function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function latencyClass(ms: number): string {
  if (ms < 150) return 'g';
  if (ms < 400) return 'm';
  return 'b';
}

const COLUMNS = 7;

export function PortTable({
  rows,
  selectedKeys,
  onToggleSelect,
  onToggleSelectAll,
  onCopy,
  onRotate,
  onStop,
  onRemove,
  onMovePort,
  api,
  notes,
  copiedKey,
  targets = [],
  limits = {},
  onAddPort,
  onSelectGroup,
  rotatingKeys,
}: PortTableProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language || 'en';
  const allSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(r.key));
  const someSelected = !allSelected && rows.some((r) => selectedKeys.has(r.key));
  // Accounts with at least one online port: their credentials demonstrably work,
  // so an auth rejection on another of their ports is location-specific (used by
  // describePortState to show a "try another location" message, not "check login").
  const onlineAccountIds = new Set(rows.filter((r) => r.state.kind === 'online').map((r) => r.accountId));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, toggleCollapsed] = useCollapsedGroups();
  const groups = useMemo(() => groupPorts(rows, targets, language), [rows, targets, language]);
  const targetByKey = useMemo(() => new Map(targets.map((tg) => [tg.key, tg])), [targets]);
  const remaining = useMemo(() => remainingByProvider(rows, limits), [rows, limits]);

  // Spec §4.2 "live retry countdown": tick once a second, but only while at
  // least one row actually has a countdown, and as a single interval shared
  // by the whole table (not one per row).
  const [, setTick] = useState(0);
  useEffect(() => {
    const hasCountdown = rows.some(
      (r) => r.state.kind === 'retrying' || (r.state.kind === 'failed' && !isTerminalFailure(r.state.reason)),
    );
    if (!hasCountdown) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [rows]);

  // When each countdown started, so the ring can show how much of the wait
  // has elapsed (PortState only carries the deadline).
  const waitStarts = useRef(new Map<string, { until: number; from: number }>());
  function ringProgress(key: string, until: number): number {
    const now = Date.now();
    let entry = waitStarts.current.get(key);
    if (!entry || entry.until !== until) {
      entry = { until, from: now };
      waitStarts.current.set(key, entry);
    }
    const span = entry.until - entry.from;
    return span > 0 ? Math.min(1, Math.max(0, (now - entry.from) / span)) : 1;
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderGroupHeader(group: PortGroup, isCollapsed: boolean) {
    const location = group.name;
    const keys = group.rows.map((r) => r.key);
    const picked = keys.filter((k) => selectedKeys.has(k)).length;
    const allPicked = picked === keys.length;
    const target = group.target;
    const block = target ? addPortBlock(target, remaining) : undefined;
    const provider = providerName(group.providerId, t);
    const blockReason =
      block === 'not-in-plan'
        ? t('main.picker.notInPlanHint', { provider })
        : block === 'limit-reached'
          ? t('main.group.limitReached', { provider, limit: limits[group.providerId] })
          : block === 'no-free-server'
            ? t('main.group.noFreeServer', { location })
            : undefined;
    return (
      <tr className="grp-row" data-testid={`group-${group.locationKey}`}>
        <td className="c-sel">
          {onSelectGroup && (
            <input
              type="checkbox"
              className="ck"
              aria-label={t('main.group.select', { location }) as string}
              checked={allPicked}
              ref={(el) => {
                if (el) el.indeterminate = picked > 0 && !allPicked;
              }}
              onChange={() => onSelectGroup(keys, !allPicked)}
            />
          )}
        </td>
        <td colSpan={COLUMNS - 1}>
          <div className="grp-bar">
            <button
              type="button"
              className="grp-tg"
              aria-expanded={!isCollapsed}
              aria-label={t('main.group.toggle', { location }) as string}
              onClick={() => toggleCollapsed(group.locationKey)}
            >
              <Icon name="chevron" className="grp-chev" />
              <Flag country={group.country} />
              <span
                className="grp-name"
                title={group.countryWide ? `${group.name} · ${provider}` : `${group.name} · ${countryName(group.country, language)} · ${provider}`}
              >
                <b>{group.name}</b>
                <span className="grp-sub">
                  {/* A country-wide location is already named after the country. */}
                  {!group.countryWide && countryName(group.country, language)}
                  {target?.virtualLocation && (
                    <span className="pill virt" title={t('main.virtualLocationHint', { provider }) as string} data-testid={`virtual-${group.locationKey}`}>
                      {t('main.virtualLocation')}
                    </span>
                  )}
                  <span className={`psw ${group.providerId}`} aria-hidden="true" />
                  {provider}
                </span>
              </span>
            </button>
            <span className="grp-stats" data-testid={`group-stats-${group.locationKey}`}>
              <span className="grp-on">
                <span className={`live-dot${group.online ? ' on' : ''}`} aria-hidden="true" />
                {t('main.group.ports', { count: group.rows.length })} · {t('main.group.online', { count: group.online })}
              </span>
              {target && (
                <span className="grp-pool">
                  {t('main.group.servers', { count: target.servers.length })}
                  {target.notInPlan ? (
                    <>
                      {' · '}
                      <span className="free none not-in-plan" title={t('main.picker.notInPlanHint', { provider }) as string} data-testid={`not-in-plan-${group.locationKey}`}>
                        {t('main.picker.notInPlan')}
                      </span>
                    </>
                  ) : target.freeServers != null && (
                    <>
                      {' · '}
                      <span className={target.freeServers ? 'free' : 'free none'}>
                        {t('main.group.free', { count: target.freeServers })}
                      </span>
                    </>
                  )}
                </span>
              )}
            </span>
            <span className="sp" />
            {onAddPort && target && (
              <button
                type="button"
                className={`btn ghost sm grp-add${block ? ' is-disabled' : ''}`}
                aria-disabled={block ? true : undefined}
                aria-label={t('main.group.addPortLabel', { location }) as string}
                title={(blockReason ?? t('main.group.addPortHint', { location })) as string}
                onClick={() => {
                  if (!block) onAddPort(group.locationKey);
                }}
                data-testid={`add-port-${group.locationKey}`}
              >
                <Icon name="plus" />
                <span>{t('main.group.addPort')}</span>
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  function renderRow(row: PortRow) {
        const view = describePortState(row.state, row.providerId, t, {
          accountHasWorkingPeer: onlineAccountIds.has(row.accountId),
        });
        const state = row.state;
        const note = notes?.[row.key];
        const selected = selectedKeys.has(row.key);
        const isOpen = expanded.has(row.key);
        const n = portNumber(row);
        const serverIp = row.serverIp ?? row.server;
        const rowLocation = locationName({ ...row, countryWide: targetByKey.get(row.locationKey)?.countryWide }, language);
        // Tagged with the location's country; the probe's geolocation is only a hint.
        const exit: ExitCountryView = state.kind === 'online' ? exitCountry(row.country, state.country) : {};
        // NordVPN: the exit belongs to the connection, not the server (spec §5.5).
        const sessionExit = EXIT_IP_MODELS[row.providerId] === 'session';
        const portLabel = n ? (t('main.port.label', { location: rowLocation, n }) as string) : row.label;
        // Change IP picks another server: useful when online and when stuck
        // retrying / failed on a bad server; not while stopped or mid-connect.
        const canChangeIp = state.kind === 'online' || state.kind === 'retrying' || state.kind === 'failed';
        // A terminal failure (bad credentials / not in plan) shows no progress
        // ring — there is no next attempt to count down to.
        const waiting = state.kind === 'retrying' || (state.kind === 'failed' && !view.terminal);
        const rowClass = ['row', selected ? 'is-selected' : '', state.kind === 'failed' ? 'is-failed' : '']
          .filter(Boolean)
          .join(' ');
        return (
          <Fragment key={row.key}>
            <tr className={rowClass} data-testid={`port-row-${row.key}`}>
              <td className="c-sel">
                <input
                  type="checkbox"
                  className="ck"
                  aria-label={portLabel}
                  checked={selected}
                  onChange={() => onToggleSelect(row.key)}
                />
              </td>
              <td className="c-st">
                <div className="st">
                  {waiting ? (
                    <span
                      className={`ring${state.kind === 'failed' ? ' bad' : ''}`}
                      style={{ ['--p' as string]: ringProgress(row.key, state.untilMs) }}
                      data-testid="status-dot"
                      data-tone={view.tone}
                      aria-hidden="true"
                    />
                  ) : (
                    <StatusDot tone={view.tone} />
                  )}
                  <span className={`lbl ${view.tone}`}>{view.label}</span>
                </div>
                {state.kind === 'retrying' && view.guidance && (
                  <div className="st-sub guidance" data-testid={`guidance-${row.key}`}>
                    {view.guidance} · {t('portState.attempt', { n: state.attempt })}
                  </div>
                )}
                {state.kind === 'failed' && (
                  <>
                    <div className="st-sub guidance bad" data-testid={`guidance-${row.key}`}>
                      {view.guidance}
                      {view.actionLabel && onMovePort && (
                        <div>
                          <button className="btn sm" onClick={() => onMovePort(row)}>
                            <Icon name="rotate" />
                            {view.actionLabel}
                          </button>
                        </div>
                      )}
                    </div>
                    {view.terminal ? (
                      <div className="st-sub" data-testid={`terminal-${row.key}`}>
                        {t('portState.actionNeeded')} · {t('portState.attempt', { n: state.attempt })}
                      </div>
                    ) : (
                      <div className="st-sub">
                        <span className="when">
                          {t('portState.nextTry', { time: clock(view.countdownSeconds ?? 0) })}
                        </span>{' '}
                        · {t('portState.attempt', { n: state.attempt })}
                      </div>
                    )}
                  </>
                )}
              </td>
              <td className="c-srv">
                <div className="srv">
                  <span className="pn">#{n ?? '–'}</span>
                  {serverIp ? (
                    <span
                      className="srv-ip mono"
                      title={t(sessionExit ? 'main.port.serverTitleSession' : 'main.port.serverTitle', { server: row.server ?? serverIp, provider: providerName(row.providerId, t) }) as string}
                    >
                      {serverIp}
                    </span>
                  ) : (
                    <span className="srv-ip none">{t('main.port.noServer')}</span>
                  )}
                </div>
              </td>
              <td>
                <button
                  className={`endpoint${copiedKey === row.key ? ' copied' : ''}`}
                  onClick={() => onCopy(row)}
                  title={t('main.copyPort') as string}
                >
                  <span>
                    <span className="host">127.0.0.1:</span>
                    {row.proxyPort}
                  </span>
                  <Icon name={copiedKey === row.key ? 'check' : 'copy'} />
                  <span className="sr-only">{t('common.copy')}</span>
                </button>
              </td>
              <td className="c-ip">
                {state.kind === 'online' ? (
                  <span className="ip">
                    <span
                      className="mono"
                      data-testid={`exit-ip-${row.key}`}
                      title={sessionExit ? (t('main.port.sessionExitTitle', { provider: providerName(row.providerId, t) }) as string) : undefined}
                    >
                      {state.exitIp}
                    </span>
                    {exit.tag && (
                      <span className="cc" title={countryName(exit.tag, language)} data-testid={`exit-cc-${row.key}`}>
                        ({exit.tag})
                      </span>
                    )}
                    {exit.tag && exit.geo && (
                      <span
                        className="geo-hint"
                        data-testid={`geo-hint-${row.key}`}
                        title={
                          t('main.port.geoHintTitle', {
                            ip: state.exitIp,
                            geo: countryName(exit.geo, language),
                            country: countryName(exit.tag, language),
                          }) as string
                        }
                      >
                        {t('main.port.geoHint', { country: exit.geo })}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="none">—</span>
                )}
              </td>
              <td className="num c-lat">
                {state.kind === 'online' && state.latencyMs != null ? (
                  <span className={`lat ${latencyClass(state.latencyMs)}`}>{state.latencyMs} ms</span>
                ) : (
                  <span className="none">—</span>
                )}
              </td>
              <td className="num">
                <div className="rowact">
                  <ChangeIpMenu
                    row={row}
                    api={api}
                    rows={rows}
                    locationName={rowLocation}
                    sameCountryAlternative={targets.some(
                      (tg) => tg.providerId === row.providerId && tg.country === row.country && tg.key !== row.locationKey && !tg.notInPlan,
                    )}
                    disabled={!canChangeIp}
                    busy={rotatingKeys?.has(row.key)}
                    onChange={onRotate}
                  />
                  {onStop && (
                    <button
                      className="btn ghost sm icon-only"
                      title={(state.kind === 'stopped' ? t('main.stopDisabledHint') : t('main.stop')) as string}
                      disabled={state.kind === 'stopped'}
                      onClick={() => onStop(row)}
                    >
                      <Icon name="power" />
                      <span className="sr-only">{t('main.stop')}</span>
                    </button>
                  )}
                  {onRemove && (
                    <button
                      className="btn ghost sm icon-only danger"
                      title={t('main.remove') as string}
                      onClick={() => onRemove(row)}
                    >
                      <Icon name="trash" />
                      <span className="sr-only">{t('main.remove')}</span>
                    </button>
                  )}
                  <button
                    className="btn ghost sm icon-only det-btn"
                    aria-expanded={isOpen}
                    title={t('main.details') as string}
                    onClick={() => toggleExpanded(row.key)}
                  >
                    <Icon name="chevron" />
                    <span className="sr-only">{t('main.details')}</span>
                  </button>
                </div>
              </td>
            </tr>
            {note && (
              // Its own full-width line under the row, so a long "a → b" never
              // wraps inside (and widens) the Status column.
              <tr className={`note-row${selected ? ' is-selected' : ''}${state.kind === 'failed' ? ' is-failed' : ''}`} data-testid={`rotate-note-row-${row.key}`}>
                <td className="c-sel" />
                <td colSpan={COLUMNS - 1}>
                  <div className="st-note" data-testid={`rotate-note-${row.key}`} role="status" title={note}>
                    <Icon name="rotate" />
                    <span>{note}</span>
                  </div>
                </td>
              </tr>
            )}
            {isOpen && <PortDetailsDrawer row={row} api={api} colSpan={COLUMNS} />}
          </Fragment>
        );
  }

  return (
    <div className="tablewrap">
      <table className="port-table">
        <thead>
          <tr>
            <th className="c-sel">
              <input
                type="checkbox"
                className="ck"
                aria-label={t('main.selectAll')}
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={onToggleSelectAll}
              />
            </th>
            <th className="c-st">{t('main.table.status')}</th>
            <th>{t('main.table.server')}</th>
            <th>{t('main.table.port')}</th>
            <th className="c-ip">{t('main.table.exitIp')}</th>
            <th className="num c-lat">{t('main.table.latency')}</th>
            <th className="num">
              <span className="sr-only">{t('main.table.actions')}</span>
            </th>
          </tr>
        </thead>
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.locationKey);
          return (
            <tbody key={group.locationKey} className={`grp-body${isCollapsed ? ' is-collapsed' : ''}`}>
              {renderGroupHeader(group, isCollapsed)}
              {!isCollapsed && group.rows.map(renderRow)}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
