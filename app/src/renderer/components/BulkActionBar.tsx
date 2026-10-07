import { useTranslation } from 'react-i18next';

export interface BulkActionBarProps {
  count: number;
  onStart: () => void;
  onStop: () => void;
  onRotate: () => void;
  onRemove: () => void;
  onExport: () => void;
  onClear: () => void;
}

export function BulkActionBar({ count, onStart, onStop, onRotate, onRemove, onExport, onClear }: BulkActionBarProps) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <div data-testid="bulk-action-bar">
      <span>{t('main.bulk.selectedCount', { count })}</span>
      <button className="btn ghost" onClick={onStart}>
        {t('main.bulk.start')}
      </button>
      <button className="btn ghost" onClick={onStop}>
        {t('main.bulk.stop')}
      </button>
      <button className="btn ghost" onClick={onRotate}>
        {t('main.bulk.rotate')}
      </button>
      <button className="btn ghost" onClick={onExport}>
        {t('main.bulk.export')}
      </button>
      <button className="btn danger ghost" onClick={onRemove}>
        {t('main.bulk.remove')}
      </button>
      <button className="btn ghost" onClick={onClear}>
        {t('main.bulk.clear')}
      </button>
    </div>
  );
}
