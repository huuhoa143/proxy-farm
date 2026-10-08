import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi } from '../../shared/contracts';
import { LINKS } from '../../shared/links';
import { formatDiagnostics } from '../diagnostics';
import { Icon, type IconName } from '../ui/Icon';
import { DisclaimerModal, PrivacyModal } from './PolicyModals';

export interface AboutSectionProps {
  api: ProxyFarmApi;
  version: string;
}

/** An external link styled as a button. `target=_blank` hands it to main's window-open
 * handler, which opens it in the browser only if it is on the GitHub allowlist. */
function ExternalLink({ href, icon, label, testId }: { href: string; icon: IconName; label: string; testId: string }) {
  return (
    <a className="btn sm" href={href} target="_blank" rel="noreferrer" data-testid={testId}>
      <Icon name={icon} />
      {label}
    </a>
  );
}

function AboutRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <span className="lbl">{label}</span>
        {note && <div className="note">{note}</div>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Settings → About & help: identity (name, version, license), where to get help
 * (GitHub only — no email), the privacy summary and disclaimer, and a redacted
 * "Copy diagnostics" for bug reports.
 */
export function AboutSection({ api, version }: AboutSectionProps) {
  const { t } = useTranslation();
  const [modal, setModal] = useState<'privacy' | 'disclaimer' | null>(null);
  const [copy, setCopy] = useState<CopyState>('idle');

  useEffect(() => {
    if (copy === 'idle') return undefined;
    const id = setTimeout(() => setCopy('idle'), copy === 'copied' ? 1600 : 5000);
    return () => clearTimeout(id);
  }, [copy]);

  async function copyDiagnostics() {
    try {
      const text = formatDiagnostics(await api.getDiagnostics());
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <section className="panel about" data-testid="about-section" aria-labelledby="about-title">
      <div className="panel-h">
        <h2 id="about-title">
          <Icon name="info" />
          {t('about.title')}
        </h2>
      </div>
      <div className="about-id">
        <div className="about-mark" aria-hidden="true">
          <Icon name="relay" />
        </div>
        <div>
          <div className="about-name">
            {t('common.appName')}
            <span className="pill mono" data-testid="about-version">
              v{version}
            </span>
            <span className="pill">{t('about.license')}</span>
          </div>
          <p className="about-tagline">{t('about.tagline')}</p>
        </div>
      </div>

      <div className="set-rows">
        <AboutRow label={t('about.getHelp')} note={t('about.getHelpNote')}>
          <ExternalLink href={LINKS.discussions} icon="mail" label={t('about.open')} testId="about-help" />
        </AboutRow>
        <AboutRow label={t('about.reportBug')} note={t('about.reportBugNote')}>
          <ExternalLink href={LINKS.newIssue} icon="alert" label={t('about.open')} testId="about-bug" />
        </AboutRow>
        <AboutRow label={t('about.diagnostics')} note={t('about.diagnosticsNote')}>
          <button className="btn sm" data-testid="about-diagnostics" onClick={() => void copyDiagnostics()}>
            <Icon name={copy === 'copied' ? 'check' : 'copy'} />
            {copy === 'copied' ? t('about.diagnosticsCopied') : t('common.copy')}
          </button>
        </AboutRow>
        {copy === 'failed' && (
          <p className="result bad" role="alert" data-testid="about-diagnostics-failed">
            <Icon name="alert" />
            <span>{t('about.diagnosticsFailed')}</span>
          </p>
        )}
        <AboutRow label={t('about.reportSecurity')} note={t('about.reportSecurityNote')}>
          <ExternalLink href={LINKS.securityAdvisory} icon="shield" label={t('about.open')} testId="about-security" />
        </AboutRow>
        <AboutRow label={t('about.privacy')} note={t('about.privacyNote')}>
          <button className="btn sm" data-testid="about-privacy" onClick={() => setModal('privacy')}>
            <Icon name="shield" />
            {t('about.read')}
          </button>
        </AboutRow>
        <AboutRow label={t('about.disclaimer')} note={t('about.disclaimerNote')}>
          <button className="btn sm" data-testid="about-disclaimer" onClick={() => setModal('disclaimer')}>
            <Icon name="info" />
            {t('about.read')}
          </button>
        </AboutRow>
        <AboutRow label={t('about.thirdParty')} note={t('about.thirdPartyNote')}>
          <ExternalLink href={LINKS.thirdPartyNotices} icon="file" label={t('about.open')} testId="about-third-party" />
        </AboutRow>
        <div className="about-links">
          <ExternalLink href={LINKS.source} icon="export" label={t('about.source')} testId="about-source" />
          <ExternalLink href={LINKS.releases} icon="activity" label={t('about.releaseNotes')} testId="about-releases" />
        </div>
      </div>

      {modal === 'privacy' && <PrivacyModal onClose={() => setModal(null)} />}
      {modal === 'disclaimer' && <DisclaimerModal onClose={() => setModal(null)} />}
    </section>
  );
}
