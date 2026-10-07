import { useTranslation } from 'react-i18next';
import type { PortRow } from '../../shared/contracts';
import { describePortState } from '../portStateView';
import { StatusDot } from './StatusDot';

export interface PortTableProps {
  rows: PortRow[];
  selectedKeys: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  onToggleSelectAll: () => void;
  onCopy: (row: PortRow) => void;
  onRotate: (row: PortRow) => void;
  onMovePort?: (row: PortRow) => void;
}

export function PortTable({ rows, selectedKeys, onToggleSelect, onToggleSelectAll, onCopy, onRotate, onMovePort }: PortTableProps) {
  const { t } = useTranslation();
  const allSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(r.key));

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
          return (
            <tr key={row.key} data-testid={`port-row-${row.key}`}>
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
                <button
                  className="btn ghost"
                  disabled={row.state.kind !== 'online'}
                  onClick={() => onRotate(row)}
                >
                  {t('main.rotate')}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
