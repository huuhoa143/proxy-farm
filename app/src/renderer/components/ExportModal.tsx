import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat, ProxyFarmApi } from '../../shared/contracts';

const FORMATS: ExportFormat[] = ['hostPortUserPass', 'socks5Url', 'hostPort', 'curl'];

export interface ExportModalProps {
  api: ProxyFarmApi;
  targetKeys: string[];
  onClose: () => void;
}

export function ExportModal({ api, targetKeys, onClose }: ExportModalProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>('hostPortUserPass');
  const [text, setText] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api.exportPorts(targetKeys, format).then((result) => {
      if (!cancelled) setText(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api, targetKeys, format]);

  return (
    <div className="modal-scrim" data-testid="export-modal" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>{t('main.export.title')}</h2>
        <div role="radiogroup" aria-label={t('main.export.title') as string}>
          {FORMATS.map((f) => (
            <label key={f}>
              <input type="radio" name="export-format" checked={format === f} onChange={() => setFormat(f)} />
              {t(`main.export.format.${f}`)}
            </label>
          ))}
        </div>
        <textarea readOnly value={text} rows={Math.min(10, Math.max(3, targetKeys.length))} data-testid="export-text" />
        <div>
          <button className="btn primary" onClick={() => navigator.clipboard?.writeText(text)}>
            {t('main.export.copyAll')}
          </button>
          <button className="btn ghost" onClick={onClose}>
            {t('main.export.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
