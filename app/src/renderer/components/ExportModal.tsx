import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat, ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';

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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.exportPorts(targetKeys, format).then((result) => {
      if (!cancelled) setText(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api, targetKeys, format]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <div className="modal-scrim" data-testid="export-modal" onClick={onClose}>
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mh">
          <h2 id="export-title">{t('main.export.title')}</h2>
          <button className="iconbtn" onClick={onClose} aria-label={t('main.export.close') as string}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb">
          <div className="seg" role="radiogroup" aria-label={t('main.export.title') as string}>
            {FORMATS.map((f) => (
              <label key={f} className={format === f ? 'on' : undefined}>
                <input type="radio" name="export-format" checked={format === f} onChange={() => setFormat(f)} />
                {t(`main.export.format.${f}`)}
              </label>
            ))}
          </div>
          <textarea
            readOnly
            value={text}
            rows={Math.min(10, Math.max(3, targetKeys.length))}
            data-testid="export-text"
            spellCheck={false}
          />
        </div>
        <div className="mf">
          <span className="sum">{t('main.export.count', { count: targetKeys.length })}</span>
          <button className="btn ghost" onClick={onClose}>
            {t('main.export.close')}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              void navigator.clipboard?.writeText(text);
              setCopied(true);
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? t('common.copied') : t('main.export.copyAll')}
          </button>
        </div>
      </div>
    </div>
  );
}
