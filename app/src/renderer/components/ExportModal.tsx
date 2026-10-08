import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat, ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';
import { useModalFocusTrap } from '../ui/useModalFocusTrap';

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
  const [copyError, setCopyError] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useModalFocusTrap(boxRef, onClose);

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
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  async function copyAll() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyError(false);
      setCopied(true);
    } catch {
      // Clipboard blocked: tell the user and preselect the textarea so they can copy by hand.
      setCopied(false);
      setCopyError(true);
      textRef.current?.focus();
      textRef.current?.select();
    }
  }

  return (
    <div className="modal-scrim" data-testid="export-modal" onClick={onClose}>
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        ref={boxRef}
        tabIndex={-1}
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
            ref={textRef}
            readOnly
            value={text}
            rows={Math.min(10, Math.max(3, targetKeys.length))}
            data-testid="export-text"
            spellCheck={false}
          />
          {copyError && (
            <p className="result bad" data-testid="export-copy-error" role="alert">
              <Icon name="alert" />
              <span>{t('main.export.copyFailed')}</span>
            </p>
          )}
        </div>
        <div className="mf">
          <span className="sum">{t('main.export.count', { count: targetKeys.length })}</span>
          <button className="btn ghost" onClick={onClose}>
            {t('main.export.close')}
          </button>
          <button className="btn primary" onClick={() => void copyAll()}>
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? t('common.copied') : t('main.export.copyAll')}
          </button>
        </div>
      </div>
    </div>
  );
}
