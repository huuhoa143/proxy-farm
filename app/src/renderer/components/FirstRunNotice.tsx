import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DISCLAIMER_NOTICE_VERSION, type ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';
import { DisclaimerModal } from './PolicyModals';

/** The notice's points, in display order (`firstRun.<key>`). */
export const FIRST_RUN_POINTS = ['ownAccounts', 'terms', 'suspension', 'asIs', 'notAffiliated'] as const;

export interface FirstRunNoticeProps {
  api: ProxyFarmApi;
  /** Called once the acknowledgement was saved. */
  onAcknowledged: () => void;
}

/**
 * The short disclaimer a user acknowledges once ("I understand"), stored as
 * `Settings.acknowledgedDisclaimer`. A banner, not a blocking modal: on an existing
 * install it appears on the next launch while the restarted ports keep running.
 */
export function FirstRunNotice({ api, onAcknowledged }: FirstRunNoticeProps) {
  const { t } = useTranslation();
  const [showFull, setShowFull] = useState(false);
  const [saving, setSaving] = useState(false);

  async function acknowledge() {
    setSaving(true);
    try {
      await api.setSettings({ acknowledgedDisclaimer: DISCLAIMER_NOTICE_VERSION });
      onAcknowledged();
    } catch {
      // Not saved: keep the notice up so it is asked again rather than silently lost.
      setSaving(false);
    }
  }

  return (
    <div className="callout warn app-banner first-run" role="region" aria-labelledby="first-run-title" data-testid="first-run-notice">
      <Icon name="info" />
      <div className="first-run-body">
        <strong id="first-run-title">{t('firstRun.title')}</strong>
        <ul>
          {FIRST_RUN_POINTS.map((key) => (
            <li key={key}>{t(`firstRun.${key}`)}</li>
          ))}
        </ul>
        <div className="btns">
          <button className="btn primary sm" disabled={saving} onClick={() => void acknowledge()} data-testid="first-run-ack">
            <Icon name="check" />
            {t('firstRun.acknowledge')}
          </button>
          <button className="btn ghost sm" onClick={() => setShowFull(true)} data-testid="first-run-full">
            {t('firstRun.readFull')}
          </button>
        </div>
      </div>
      {showFull && <DisclaimerModal onClose={() => setShowFull(false)} />}
    </div>
  );
}
