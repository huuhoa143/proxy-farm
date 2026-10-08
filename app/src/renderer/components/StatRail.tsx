import { useTranslation } from 'react-i18next';
import type { PortRow } from '../../shared/contracts';

/** Integrated stat strip (v1 language): online / locations / countries / avg latency. */
export function StatRail({ rows }: { rows: PortRow[] }) {
  const { t } = useTranslation();
  const online = rows.filter((r) => r.state.kind === 'online');
  const countries = new Set(rows.map((r) => r.country)).size;
  // Several ports can share a location (spec §6.8): count locations, not rows.
  const locations = new Set(rows.map((r) => r.locationKey || r.key)).size;
  const latencies = online
    .map((r) => (r.state.kind === 'online' ? r.state.latencyMs : undefined))
    .filter((ms): ms is number => typeof ms === 'number');
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  return (
    <section className="stats" data-testid="stat-rail" aria-label={t('main.stats.label') as string}>
      <div className="stat hero">
        <span className="k">
          <span className={`live-dot${online.length ? ' on' : ''}`} />
          {t('main.stats.online')}
        </span>
        <span className="v">
          {online.length}
          <small>{t('main.stats.ofTotal', { total: rows.length })}</small>
        </span>
      </div>
      <div className="stat">
        <span className="k">{t('main.stats.locations')}</span>
        <span className="v">{locations}</span>
      </div>
      <div className="stat">
        <span className="k">{t('main.stats.countries')}</span>
        <span className="v">{countries}</span>
      </div>
      <div className="stat">
        <span className="k">{t('main.stats.avgLatency')}</span>
        <span className="v">
          {avg === null ? '—' : avg}
          {avg !== null && <small>ms</small>}
        </span>
      </div>
    </section>
  );
}
