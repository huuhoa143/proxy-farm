import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortRow, ProxyFarmApi } from '../../shared/contracts';

export interface PortDetailsDrawerProps {
  row: PortRow;
  api: ProxyFarmApi;
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
export function PortDetailsDrawer({ row, api }: PortDetailsDrawerProps) {
  const { t } = useTranslation();
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

  return (
    <tr data-testid={`details-${row.key}`}>
      <td colSpan={7}>
        <section>
          <h4>{t('main.logs.title')}</h4>
          <button className="btn ghost" onClick={() => void refreshLogs()}>
            {t('main.logs.refresh')}
          </button>
          <pre data-testid={`logs-${row.key}`}>
            {logs === null ? t('common.loading') : logs.length ? logs.join('\n') : t('main.logs.empty')}
          </pre>
        </section>
        <section>
          <button className="btn ghost" disabled={testing !== 'none'} onClick={() => void runTest(false)}>
            {testing === 'basic' ? t('main.test.running') : t('main.test.run')}
          </button>
          <button className="btn ghost" disabled={testing !== 'none'} onClick={() => void runTest(true)}>
            {testing === 'speed' ? t('main.test.speedRunning') : t('main.test.speedRun')}
          </button>
          {testResult && (
            <span data-testid={`test-result-${row.key}`}>
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
          )}
        </section>
        <section>
          <label>
            {t('main.autoRotate.label')}
            <input
              type="number"
              min={0}
              defaultValue={row.autoRotateMin}
              aria-label={t('main.autoRotate.label') as string}
              onBlur={(e) => void api.setAutoRotate(row.key, Math.max(0, Number(e.target.value) || 0))}
            />
            {t('main.autoRotate.minutesSuffix')}
          </label>
          <span>{row.autoRotateMin === 0 ? t('main.autoRotate.off') : null}</span>
        </section>
      </td>
    </tr>
  );
}
