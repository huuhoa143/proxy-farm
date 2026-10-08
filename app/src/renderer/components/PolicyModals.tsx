import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LINKS } from '../../shared/links';
import { Icon } from '../ui/Icon';
import { useModalFocusTrap } from '../ui/useModalFocusTrap';

/** Bullet keys of the in-app privacy summary, in display order (`privacy.<key>`). */
export const PRIVACY_POINTS = ['collectsNothing', 'local', 'providers', 'ipCheck', 'optional', 'delete'] as const;

/** Paragraph keys of the in-app disclaimer, in display order (`disclaimer.<key>`). */
export const DISCLAIMER_PARAGRAPHS = ['asIs', 'liability', 'ownAccounts', 'suspension', 'noGuarantee', 'trademarks'] as const;

/** A read-only, focus-trapped text modal with a link to the full document on GitHub.
 * The link opens in the browser through main's allowlisted window-open handler. */
function PolicyModal({
  id,
  title,
  fullLabel,
  fullHref,
  onClose,
  children,
}: {
  id: string;
  title: string;
  fullLabel: string;
  fullHref: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(boxRef, onClose);
  return (
    <div className="modal-scrim" data-testid={`${id}-modal`} onClick={onClose}>
      <div
        className="modal-box policy-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        ref={boxRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mh">
          <h2 id={`${id}-title`}>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label={t('common.close') as string}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb policy-body">{children}</div>
        <div className="mf">
          <a className="btn ghost" href={fullHref} target="_blank" rel="noreferrer" data-testid={`${id}-full`}>
            <Icon name="export" />
            {fullLabel}
          </a>
          <button className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PrivacyModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <PolicyModal id="privacy" title={t('privacy.title')} fullLabel={t('privacy.fullPolicy')} fullHref={LINKS.privacy} onClose={onClose}>
      <ul className="policy-list">
        {PRIVACY_POINTS.map((key) => (
          <li key={key}>{t(`privacy.${key}`)}</li>
        ))}
      </ul>
    </PolicyModal>
  );
}

export function DisclaimerModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <PolicyModal
      id="disclaimer"
      title={t('disclaimer.title')}
      fullLabel={t('disclaimer.full')}
      fullHref={LINKS.disclaimer}
      onClose={onClose}
    >
      {DISCLAIMER_PARAGRAPHS.map((key) => (
        <p key={key}>{t(`disclaimer.${key}`)}</p>
      ))}
    </PolicyModal>
  );
}
