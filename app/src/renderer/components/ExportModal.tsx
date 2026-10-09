import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat, PortRow, ProxyFarmApi, SaveExportResult } from '../../shared/contracts';
import { bucketOf, exportChecks, type CheckRecord } from '../portFilter';
import { Icon } from '../ui/Icon';
import { useModalFocusTrap } from '../ui/useModalFocusTrap';

const FORMATS: ExportFormat[] = ['hostPortUserPass', 'socks5Url', 'hostPort', 'curl', 'csv'];

export interface ExportModalProps {
  api: ProxyFarmApi;
  targetKeys: string[];
  /** Every port, to tell which of `targetKeys` are alive. */
  rows: readonly PortRow[];
  /** Check results: they decide "alive" and feed the CSV's status/latency. */
  checks?: Readonly<Record<string, CheckRecord>>;
  onClose: () => void;
}

const NO_CHECKS: Readonly<Record<string, CheckRecord>> = {};

export function ExportModal({ api, targetKeys, rows, checks = NO_CHECKS, onClose }: ExportModalProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>('hostPortUserPass');
  const [aliveOnly, setAliveOnly] = useState(true);
  // The text and the request it answers: Save waits until it matches what is shown.
  const [exported, setExported] = useState({ sig: '', text: '' });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveExportResult | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useModalFocusTrap(boxRef, onClose);

  const included = useMemo(() => {
    if (!aliveOnly) return targetKeys;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return targetKeys.filter((k) => {
      const row = byKey.get(k);
      return row !== undefined && bucketOf(row, checks) === 'alive';
    });
  }, [aliveOnly, targetKeys, rows, checks]);
  const leftOut = targetKeys.length - included.length;
  // Ports push state changes (latency ticks) all the time: only re-export when the
  // exported set, or what the CSV says about it, actually changed.
  const includedSig = included.join('\n');
  const checksSig = useMemo(() => {
    if (format !== 'csv') return '';
    const keys = new Set(included);
    return JSON.stringify(exportChecks(rows.filter((r) => keys.has(r.key)), checks));
  }, [format, included, rows, checks]);

  const sig = `${format}|${includedSig}|${checksSig}`;
  const text = exported.text;
  const ready = exported.sig === sig;

  useEffect(() => {
    let cancelled = false;
    const keys = includedSig ? includedSig.split('\n') : [];
    const request = format === 'csv' ? api.exportPorts(keys, format, JSON.parse(checksSig)) : api.exportPorts(keys, format);
    void request.then((result) => {
      if (!cancelled) setExported({ sig: `${format}|${includedSig}|${checksSig}`, text: result });
    });
    return () => {
      cancelled = true;
    };
  }, [api, includedSig, checksSig, format]);

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

  async function saveToFile() {
    setSaving(true);
    setSaveResult(null);
    try {
      const result = await api.saveExportFile(text, format);
      // Cancelled in the dialog: nothing to say.
      if (result.saved || result.error) setSaveResult(result);
    } catch (err) {
      setSaveResult({ saved: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
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
          <label className="export-alive">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={aliveOnly}
              onChange={(e) => setAliveOnly(e.target.checked)}
              data-testid="export-alive-only"
            />
            <span>{t('main.export.aliveOnly')}</span>
            {leftOut > 0 && (
              <span className="left-out" data-testid="export-left-out">
                {t('main.export.leftOut', { count: leftOut })}
              </span>
            )}
          </label>
          <textarea
            ref={textRef}
            readOnly
            value={text}
            rows={Math.min(10, Math.max(3, included.length + (format === 'csv' ? 1 : 0)))}
            data-testid="export-text"
            spellCheck={false}
            // One proxy (or CSV row) per line: scroll sideways rather than wrap a row in two.
            wrap="off"
          />
          {copyError && (
            <p className="result bad" data-testid="export-copy-error" role="alert">
              <Icon name="alert" />
              <span>{t('main.export.copyFailed')}</span>
            </p>
          )}
          {saveResult?.saved && (
            <p className="result ok" data-testid="export-saved" role="status">
              <Icon name="check" />
              <span>{t('main.export.saved', { path: saveResult.path })}</span>
            </p>
          )}
          {saveResult?.error && (
            <p className="result bad" data-testid="export-save-error" role="alert">
              <Icon name="alert" />
              <span>{t('main.export.saveFailed', { error: saveResult.error })}</span>
            </p>
          )}
        </div>
        <div className="mf">
          <span className="sum" data-testid="export-count">
            {t('main.export.count', { count: included.length })}
          </span>
          <button className="btn ghost" onClick={onClose}>
            {t('main.export.close')}
          </button>
          <button className="btn ghost" onClick={() => void saveToFile()} disabled={saving || !ready || included.length === 0} data-testid="export-save">
            <Icon name="file" />
            {t('main.export.saveFile')}
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
