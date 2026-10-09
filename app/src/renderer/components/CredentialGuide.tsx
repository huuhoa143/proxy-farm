import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon';

export interface CredentialGuideProps {
  /** The collapsed line, e.g. "How to get the username and password". */
  title: string;
  /** Numbered steps, in order. */
  steps: ReactNode[];
  /** Short caveats under the steps. */
  notes?: ReactNode[];
  /** The provider page the steps start on. It must be in `PROVIDER_LINKS` (shared/links.ts):
   * `target=_blank` hands it to main's window-open handler, which opens only allowlisted
   * URLs, in the system browser. */
  link?: { href: string; label: string };
  testId: string;
}

/** A collapsible "how to get this credential" list for an add-account card. */
export function CredentialGuide({ title, steps, notes = [], link, testId }: CredentialGuideProps) {
  return (
    <details className="cred-guide" data-testid={testId}>
      <summary>
        <Icon name="info" />
        <span>{title}</span>
        <Icon name="chevron" />
      </summary>
      <div className="cred-guide-body">
        <ol className="steps">
          {steps.map((step, i) => (
            <li key={i}>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        {notes.map((note, i) => (
          <p className="hint" key={i}>
            {note}
          </p>
        ))}
        {link && (
          <a className="btn sm" href={link.href} target="_blank" rel="noreferrer">
            <Icon name="export" />
            {link.label}
          </a>
        )}
      </div>
    </details>
  );
}
