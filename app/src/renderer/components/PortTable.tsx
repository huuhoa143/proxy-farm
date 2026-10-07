import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi } from '../../shared/contracts';
import { describePortState } from '../portStateView';
import { StatusDot } from './StatusDot';
import { PortDetailsDrawer } from './PortDetailsDrawer';

export interface PortTableProps {
  rows: PortRow[];
  selectedKeys: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  onToggleSelectAll: () => void;
  onCopy: (row: PortRow) => void;
  onRotate: (row: PortRow) => void;
  onMovePort?: (row: PortRow) => void;
  /** The real/fake ProxyFarmApi, used by the per-row Details drawer (logs/test/auto-rotate). */
  api: ProxyFarmApi;
  /** Ephemeral rotate-result notes (e.g. "Exit IP changed: … → …"), keyed by row.key. */
  notes?: Record<string, string>;
}

export function PortTable({
  rows,
  selectedKeys,
  onToggleSelect,
  onToggleSelectAll,
  onCopy,
  onRotate,
  onMovePort,
  api,
  notes,
}: PortTableProps) {
  const { t } = useTranslation();
  const allSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(r.key));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Spec §4.2 "live retry countdown": tick once a second, but only while at
  // least one row actually has a countdown, and as a single interval shared
  // by the whole table (not one per row).
  const [, setTick] = useState(0);
  useEffect(() => {
    const hasCountdown = rows.some((r) => r.state.kind === 'retrying' || r.state.kind === 'failed');
    if (!hasCountdown) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [rows]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <table className="port-table">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              aria-label={t('main.selectAll')}
              checked={allSelected}
              onChange={onToggleSelectAll}
            />
          </th>
          <th>{t('main.table.status')}</th>
          <th>{t('main.table.location')}</th>
          <th>{t('main.table.port')}</th>
          <th>{t('main.table.exitIp')}</th>
          <th>{t('main.table.latency')}</th>
          <th>{t('main.table.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const view = describePortState(row.state, row.providerId, t);
          const exitIp = row.state.kind === 'online' ? row.state.exitIp : '—';
          const latency = row.state.kind === 'online' && row.state.latencyMs != null ? `${row.state.latencyMs} ms` : '—';
          const note = notes?.[row.key];
          return (
            <Fragment key={row.key}>
              <tr data-testid={`port-row-${row.key}`}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={row.label}
                    checked={selectedKeys.has(row.key)}
                    onChange={() => onToggleSelect(row.key)}
                  />
                </td>
                <td>
                  <div className="st">
                    <StatusDot tone={view.tone} />
                    <span>{view.label}</span>
                  </div>
                  {view.guidance && (
                    <div className="guidance" data-testid={`guidance-${row.key}`}>
                      {view.guidance}
                      {view.actionLabel && onMovePort && (
                        <>
                          {' '}
                          <button className="btn ghost" onClick={() => onMovePort(row)}>
                            {view.actionLabel}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {note && (
                    <div className="guidance" data-testid={`rotate-note-${row.key}`}>
                      {note}
                    </div>
                  )}
                </td>
                <td>{row.label}</td>
                <td>
                  <span className="chip">
                    127.0.0.1:{row.proxyPort}
                    <button className="btn ghost" onClick={() => onCopy(row)} title={t('main.copyPort') as string}>
                      {t('common.copy')}
                    </button>
                  </span>
                </td>
                <td>
                  {exitIp}
                  {row.state.kind === 'online' ? ` (${row.state.country})` : ''}
                </td>
                <td>{latency}</td>
                <td>
                  <button className="btn ghost" disabled={row.state.kind !== 'online'} onClick={() => onRotate(row)}>
                    {t('main.rotate')}
                  </button>
                  <button className="btn ghost" onClick={() => toggleExpanded(row.key)}>
                    {t('main.details')}
                  </button>
                </td>
              </tr>
              {expanded.has(row.key) && <PortDetailsDrawer row={row} api={api} />}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
