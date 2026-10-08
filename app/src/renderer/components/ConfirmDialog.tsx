import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { useModalFocusTrap } from '../ui/useModalFocusTrap';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  /** Confirm button label; defaults to a generic "Continue". */
  confirmLabel?: string;
  /** Marks the action as destructive (red confirm button). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small focus-trapped yes/no modal, used before destructive bulk actions. */
export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(boxRef, onCancel);

  return (
    <div className="modal-scrim" data-testid="confirm-dialog" onClick={onCancel}>
      <div
        className="modal-box confirm-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        ref={boxRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mh">
          <h2 id="confirm-title">{title}</h2>
        </div>
        <div className="mb">
          <p id="confirm-message">{message}</p>
        </div>
        <div className="mf">
          <button className="btn ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} data-testid="confirm-ok" onClick={onConfirm}>
            {danger && <Icon name="trash" />}
            {confirmLabel ?? t('common.continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
