import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';

/** The proxy login every port uses, with a reveal toggle (v1 "creds" chip). */
export function CredentialsChip({ api }: { api: ProxyFarmApi }) {
  const { t } = useTranslation();
  const [creds, setCreds] = useState<{ user: string; pass: string } | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then((s) => {
      if (!cancelled) setCreds({ user: s.proxyUser, pass: s.proxyPass });
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!creds) return null;
  const toggleLabel = (revealed ? t('common.hidePassword') : t('common.showPassword')) as string;
  return (
    <div className="creds">
      <span className="cl">{t('main.credentials')}</span>
      <span className="cv">{creds.user}</span>
      <span className="cs">:</span>
      <span className="cv">{revealed ? creds.pass : '•'.repeat(Math.min(10, creds.pass.length || 8))}</span>
      <button className="iconbtn" onClick={() => setRevealed((v) => !v)} aria-label={toggleLabel} title={toggleLabel}>
        <Icon name="eye" />
      </button>
    </div>
  );
}
