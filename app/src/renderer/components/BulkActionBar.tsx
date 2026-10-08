import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';

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
    <div
      className="bulk"
      data-testid="bulk-action-bar"
      role="toolbar"
      aria-label={t('main.bulk.selectedCount', { count }) as string}
    >
      <span className="n">{t('main.bulk.selectedCount', { count })}</span>
      <button className="btn ghost sm" onClick={onStart}>
        <Icon name="power" />
        {t('main.bulk.start')}
      </button>
      <button className="btn ghost sm" onClick={onStop}>
        <Icon name="power" />
        {t('main.bulk.stop')}
      </button>
      <button className="btn ghost sm" onClick={onRotate}>
        <Icon name="rotate" />
        {t('main.bulk.rotate')}
      </button>
      <button className="btn ghost sm" onClick={onExport}>
        <Icon name="export" />
        {t('main.bulk.export')}
      </button>
      <button className="btn ghost sm danger" onClick={onRemove}>
        <Icon name="trash" />
        {t('main.bulk.remove')}
      </button>
      <span className="sp" />
      <button className="btn ghost sm" onClick={onClear}>
        <Icon name="x" />
        {t('main.bulk.clear')}
      </button>
    </div>
  );
}
