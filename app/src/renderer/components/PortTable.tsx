import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi } from '../../shared/contracts';
import { describePortState, isTerminalFailure } from '../portStateView';
import { StatusDot } from './StatusDot';
import { PortDetailsDrawer } from './PortDetailsDrawer';
import { Flag } from '../ui/Flag';
import { Icon } from '../ui/Icon';
import { countryName } from '../ui/countryName';
import { providerName } from '../ui/providerName';

export interface PortTableProps {
  rows: PortRow[];
  selectedKeys: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  onToggleSelectAll: () => void;
  onCopy: (row: PortRow) => void;
  onRotate: (row: PortRow) => void;
  onStop?: (row: PortRow) => void;
  onRemove?: (row: PortRow) => void;
  onMovePort?: (row: PortRow) => void;
  /** The real/fake ProxyFarmApi, used by the per-row Details drawer (logs/test/auto-rotate). */
  api: ProxyFarmApi;
  /** Ephemeral rotate-result notes (e.g. "Exit IP changed: … → …"), keyed by row.key. */
  notes?: Record<string, string>;
  /** Row whose address was just copied (shows a check in its chip). */
  copiedKey?: string | null;
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
            <th>{t('main.table.location')}</th>
            <th>{t('main.table.port')}</th>
            <th className="c-ip">{t('main.table.exitIp')}</th>
            <th className="num c-lat">{t('main.table.latency')}</th>
            <th className="num">
              <span className="sr-only">{t('main.table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const view = describePortState(row.state, row.providerId, t, {
              accountHasWorkingPeer: onlineAccountIds.has(row.accountId),
            });
            const state = row.state;
            const note = notes?.[row.key];
            const selected = selectedKeys.has(row.key);
            const isOpen = expanded.has(row.key);
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
                      aria-label={row.label}
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
                    {note && (
                      <div className="st-note" data-testid={`rotate-note-${row.key}`} role="status">
                        <Icon name="rotate" />
                        <span>{note}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="loc">
                      <Flag country={row.country} />
                      <div className="loc-t">
                        <b>{row.city}</b>
                        <span>
                          {countryName(row.country, language)}
                          <span className={`psw ${row.providerId}`} aria-hidden="true" />
                          {providerName(row.providerId, t)}
                        </span>
                      </div>
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
                        <span className="mono">{state.exitIp}</span>
                        <span className="cc" title={countryName(state.country, language)}>
                          ({state.country})
                        </span>
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
                      <button
                        className="btn ghost sm"
                        title={(state.kind === 'online' ? t('main.rotate') : t('main.rotateDisabledHint')) as string}
                        disabled={state.kind !== 'online'}
                        onClick={() => onRotate(row)}
                      >
                        <Icon name="rotate" />
                        <span>{t('main.rotate')}</span>
                      </button>
                      {onStop && (
                        <button
                          className="btn ghost sm"
                          title={(state.kind === 'stopped' ? t('main.stopDisabledHint') : t('main.stop')) as string}
                          disabled={state.kind === 'stopped'}
                          onClick={() => onStop(row)}
                        >
                          <Icon name="power" />
                          <span>{t('main.stop')}</span>
                        </button>
                      )}
                      {onRemove && (
                        <button
                          className="btn ghost sm danger"
                          title={t('main.remove') as string}
                          onClick={() => onRemove(row)}
                        >
                          <Icon name="trash" />
                          <span>{t('main.remove')}</span>
                        </button>
                      )}
                      <button
                        className="btn ghost sm"
                        aria-expanded={isOpen}
                        title={t('main.details') as string}
                        onClick={() => toggleExpanded(row.key)}
                      >
                        <Icon name="chevron" />
                        <span>{t('main.details')}</span>
                      </button>
                    </div>
                  </td>
                </tr>
                {isOpen && <PortDetailsDrawer row={row} api={api} colSpan={COLUMNS} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
