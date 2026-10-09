import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';
import { countryName } from '../ui/countryName';

export interface PortDetailsDrawerProps {
  row: PortRow;
  api: ProxyFarmApi;
  colSpan?: number;
}

interface TestOutcome {
  ok: boolean;
  exitIp?: string;
  latencyMs?: number;
  mbps?: number;
}

/**
 * Per-row "Details" drawer (spec §4.2 "Keep" list): logs, test / speed test,
 * and an auto-rotate-every-N-minutes control. Rendered as an extra <tr> by
 * PortTable, expanded only while this row's Details button is toggled on.
 */
export function PortDetailsDrawer({ row, api, colSpan = 7 }: PortDetailsDrawerProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language || 'en';
  const [logs, setLogs] = useState<string[] | null>(null);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [testing, setTesting] = useState<'none' | 'basic' | 'speed'>('none');

  async function refreshLogs() {
    setLogs(await api.getLogs(row.key));
  }

  useEffect(() => {
    void refreshLogs();
    // Re-fetch only when the row identity changes; refreshLogs is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.key]);

  async function runTest(speed: boolean) {
    setTesting(speed ? 'speed' : 'basic');
    try {
      const result = await api.testPort(row.key, speed);
      setTestResult(result);
    } finally {
      setTesting('none');
    }
  }

  const autoRotateId = `autorotate-${row.key}`;
  return (
    <tr className="details-row" data-testid={`details-${row.key}`}>
      <td colSpan={colSpan}>
        <div className="details">
          <section>
            <h4>
              <Icon name="logs" />
              {t('main.logs.title')}
              <button className="btn ghost sm" onClick={() => void refreshLogs()}>
                <Icon name="rotate" />
                {t('main.logs.refresh')}
              </button>
            </h4>
            <pre data-testid={`logs-${row.key}`}>
              {logs === null ? t('common.loading') : logs.length ? logs.join('\n') : t('main.logs.empty')}
            </pre>
          </section>
          <section>
            <h4>
              <Icon name="activity" />
              {t('main.test.title')}
            </h4>
            {row.state.kind === 'online' && (
              // The probe's raw answer, kept here although the row tags the exit with the
              // location's country (ui/exitCountry.ts).
              <dl className="exit-facts" data-testid={`exit-facts-${row.key}`}>
                <dt>{t('main.exitFacts.ip')}</dt>
                <dd className="mono">{row.state.exitIp}</dd>
                <dt>{t('main.exitFacts.location')}</dt>
                <dd>{row.country ? `${countryName(row.country, language)} (${row.country})` : '—'}</dd>
                <dt>{t('main.exitFacts.geo')}</dt>
                <dd>
                  {/^[A-Z]{2}$/.test(row.state.country)
                    ? `${countryName(row.state.country, language)} (${row.state.country})`
                    : t('main.exitFacts.geoUnknown')}
                </dd>
              </dl>
            )}
            <div className="btns">
              <button className="btn sm" disabled={testing !== 'none'} onClick={() => void runTest(false)}>
                {testing === 'basic' ? t('main.test.running') : t('main.test.run')}
              </button>
              <button className="btn sm" disabled={testing !== 'none'} onClick={() => void runTest(true)}>
                {testing === 'speed' ? t('main.test.speedRunning') : t('main.test.speedRun')}
              </button>
            </div>
            {testResult && (
              <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`} data-testid={`test-result-${row.key}`}>
                <Icon name={testResult.ok ? 'check' : 'x'} />
                <span>
                  {!testResult.ok
                    ? t('main.test.failed')
                    : testResult.mbps != null
                      ? t('main.test.resultSpeed', {
                          exitIp: testResult.exitIp,
                          latencyMs: testResult.latencyMs,
                          mbps: testResult.mbps,
                        })
                      : t('main.test.resultOnline', { exitIp: testResult.exitIp, latencyMs: testResult.latencyMs })}
                </span>
              </div>
            )}
          </section>
          <section>
            <h4>
              <Icon name="clock" />
              {t('main.autoRotate.title')}
            </h4>
            <div className="inline-field">
              <label htmlFor={autoRotateId}>{t('main.autoRotate.label')}</label>
              <input
                id={autoRotateId}
                className="num-input"
                type="number"
                min={0}
                defaultValue={row.autoRotateMin}
                aria-label={t('main.autoRotate.label') as string}
                onBlur={(e) => void api.setAutoRotate(row.key, Math.max(0, Number(e.target.value) || 0))}
              />
              <span>{t('main.autoRotate.minutesSuffix')}</span>
            </div>
            <span className="hint">
              {row.autoRotateMin === 0
                ? t('main.autoRotate.off')
                : t('main.autoRotate.every', { count: row.autoRotateMin })}
            </span>
          </section>
        </div>
      </td>
    </tr>
  );
}
