import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckResult, ProviderId, ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';
import { Flag } from '../ui/Flag';
import { countryName } from '../ui/countryName';

interface Message {
  ok: boolean;
  text: string;
}

function resultMessage(t: ReturnType<typeof useTranslation>['t'], result: CheckResult): Message {
  if (result.ok) return { ok: true, text: result.label ? result.label : (t('checkResult.ok') as string) };
  const key = result.reasonKey ?? 'checkResult.reason.invalid-format';
  return { ok: false, text: t(key, { defaultValue: key, label: result.label ?? '' }) as string };
}

function ResultLine({ message, testId }: { message: Message | null; testId: string }) {
  if (!message) return null;
  return (
    <p className={`result ${message.ok ? 'ok' : 'bad'}`} data-testid={testId} role="status">
      <Icon name={message.ok ? 'check' : 'alert'} />
      <span>{message.text}</span>
    </p>
  );
}

interface CardShellProps {
  providerId: ProviderId;
  ready?: boolean;
  accountCount?: number;
  children: ReactNode;
}

/** Shared card frame: provider avatar, name, one-line description, connected pill. */
function CardShell({ providerId, ready, accountCount = 0, children }: CardShellProps) {
  const { t } = useTranslation();
  const name = t(`onboarding.providers.${providerId}.name`);
  return (
    <section
      className={`provider-card${ready || accountCount > 0 ? ' is-ready' : ''}`}
      data-testid={`provider-card-${providerId}`}
      aria-labelledby={`pc-${providerId}`}
    >
      <div className="pc-head">
        <span className={`pv-avatar pv-${providerId}`} aria-hidden="true">
          {providerId === 'file' ? <Icon name="file" /> : t(`onboarding.providers.${providerId}.initials`)}
        </span>
        <div className="pc-title">
          <h3 id={`pc-${providerId}`}>
            {name}
            {accountCount > 0 && (
              <span className="pill ok">{t('onboarding.status.connected', { count: accountCount })}</span>
            )}
          </h3>
          <p>{t(`onboarding.providers.${providerId}.description`)}</p>
        </div>
      </div>
      <div className="pc-body">{children}</div>
    </section>
  );
}

export interface HmaDetected {
  found: boolean;
  /** e.g. 'hma.helperMissing' — Windows detected an HMA install but the privileged helper isn't set up yet (spec §7). */
  hintKey?: string;
}

export interface HmaCardProps {
  api: ProxyFarmApi;
  detected: HmaDetected | undefined;
  onAdded: () => void;
  accountCount?: number;
}

const HMA_HELPER_MISSING_HINT = 'hma.helperMissing';

export function HmaCard({ api, detected, onAdded, accountCount }: HmaCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function connect() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.connectHma();
      setMessage(resultMessage(t, result));
      if (result.ok) onAdded();
    } finally {
      setBusy(false);
    }
  }

  async function enableSupport() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.enableHmaSupport();
      setMessage(resultMessage(t, result));
    } finally {
      setBusy(false);
    }
  }

  const helperMissing = !detected?.found && detected?.hintKey === HMA_HELPER_MISSING_HINT;

  return (
    <CardShell providerId="hma" ready={detected?.found} accountCount={accountCount}>
      {detected?.found ? (
        <>
          <div className="state-line ok">
            <span className="ic">
              <Icon name="check" />
            </span>
            <span>
              <span data-testid="hma-detected">{t('onboarding.providers.hma.detectedTitle')}</span>
              <small>{t('onboarding.providers.hma.detectedSubtitle')}</small>
            </span>
          </div>
          <div className="pc-actions">
            <button className="btn primary" onClick={connect} disabled={busy}>
              <Icon name="plug" />
              {busy ? t('onboarding.providers.hma.connecting') : t('onboarding.providers.hma.connect')}
            </button>
          </div>
        </>
      ) : helperMissing ? (
        <>
          <div className="state-line warn">
            <span className="ic">
              <Icon name="shield" />
            </span>
            <span data-testid="hma-helper-missing">{t('onboarding.providers.hma.helperMissingTitle')}</span>
          </div>
          <p className="helper-note">
            <Icon name="info" />
            <span>{t('onboarding.providers.hma.windowsHelperNote')}</span>
          </p>
          <div className="pc-actions">
            <button className="btn primary" onClick={enableSupport} disabled={busy}>
              <Icon name="shield" />
              {busy ? t('onboarding.providers.hma.enablingSupport') : t('onboarding.providers.hma.enableSupport')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="state-line wait">
            <span className="ic">
              <Icon name="search" />
            </span>
            <span data-testid="hma-not-detected">{t('onboarding.providers.hma.notDetectedTitle')}</span>
          </div>
          <ol className="steps">
            <li>{t('onboarding.providers.hma.step1')}</li>
            <li>{t('onboarding.providers.hma.step2')}</li>
            <li>{t('onboarding.providers.hma.step3')}</li>
          </ol>
          <p className="watching">
            <span className="spinner" aria-hidden="true" />
            {t('onboarding.providers.hma.waiting')}
          </p>
        </>
      )}
      <ResultLine message={message} testId="hma-message" />
    </CardShell>
  );
}

export interface ZoogVpnCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
  accountCount?: number;
}

export function ZoogVpnCard({ api, onAdded, accountCount }: ZoogVpnCardProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function check() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.addAccount('zoogvpn', { email, password });
      setMessage(resultMessage(t, result));
      if (result.ok) onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell providerId="zoogvpn" accountCount={accountCount}>
      <form
        className="pc-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && email && password) void check();
        }}
      >
        <div className="field">
          <label htmlFor="zoog-email">{t('onboarding.providers.zoogvpn.email')}</label>
          <input
            id="zoog-email"
            type="email"
            autoComplete="username"
            placeholder={t('onboarding.providers.zoogvpn.emailPlaceholder') as string}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="zoog-password">{t('onboarding.providers.zoogvpn.password')}</label>
          <input
            id="zoog-password"
            type="password"
            autoComplete="current-password"
            placeholder={t('onboarding.providers.zoogvpn.passwordPlaceholder') as string}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="pc-actions">
          <button className="btn primary" type="submit" disabled={busy || !email || !password}>
            <Icon name="check" />
            {busy ? t('onboarding.providers.zoogvpn.checking') : t('onboarding.providers.zoogvpn.check')}
          </button>
        </div>
      </form>
      <ResultLine message={message} testId="zoogvpn-message" />
    </CardShell>
  );
}

export interface SurfsharkCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
  accountCount?: number;
}

export function SurfsharkCard({ api, onAdded, accountCount }: SurfsharkCardProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.addAccount('surfshark', { privateKey: key });
      setMessage(resultMessage(t, result));
      if (result.ok) onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell providerId="surfshark" accountCount={accountCount}>
      <div className="field">
        <label htmlFor="surfshark-key">{t('onboarding.providers.surfshark.keyLabel')}</label>
        <textarea
          id="surfshark-key"
          placeholder={t('onboarding.providers.surfshark.keyPlaceholder') as string}
          value={key}
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
        <p className="hint">
          {t('onboarding.providers.surfshark.hintLead')}{' '}
          <span className="path">{t('onboarding.providers.surfshark.hintPath')}</span>
        </p>
      </div>
      <div className="pc-actions">
        <button className="btn primary" onClick={add} disabled={busy || key.length < 10}>
          <Icon name="key" />
          {t('onboarding.providers.surfshark.add')}
        </button>
      </div>
      <ResultLine message={message} testId="surfshark-message" />
    </CardShell>
  );
}

export interface FileCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
  accountCount?: number;
}

/**
 * Simple 2-letter-token heuristic (ruling B): split the basename on
 * non-letter characters and take the first all-letter token of length 2,
 * e.g. 'mullvad-se-got.conf' -> 'SE', 'us-nyc.ovpn' -> 'US'.
 */
export function guessCountryFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const tokens = base.split(/[^a-zA-Z]+/).filter(Boolean);
  const twoLetter = tokens.find((token) => token.length === 2);
  return twoLetter ? twoLetter.toUpperCase() : '';
}

interface PendingFile {
  name: string;
  content: string;
}

export function FileCard({ api, onAdded, accountCount }: FileCardProps) {
  const { t, i18n } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [country, setCountry] = useState('');

  async function stageFile(file: File) {
    const content = await file.text();
    setPending({ name: file.name, content });
    setCountry(guessCountryFromFilename(file.name));
    setMessage(null);
  }

  async function confirmImport() {
    if (!pending) return;
    const result = await api.importConfigFile(pending.name, pending.content, country || undefined);
    setMessage(resultMessage(t, result));
    if (result.ok) {
      setPending(null);
      setCountry('');
      onAdded();
    }
  }

  const validCountry = /^[A-Z]{2}$/.test(country);

  return (
    <CardShell providerId="file" accountCount={accountCount}>
      {!pending ? (
        <div
          className={`dropzone${dragOver ? ' dragover' : ''}`}
          data-testid="file-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void stageFile(file);
          }}
        >
          <Icon name="upload" />
          <span>{t('onboarding.providers.file.dragHint')}</span>
          <label className="btn sm">
            {t('onboarding.providers.file.browse')}
            <input
              type="file"
              accept=".ovpn,.conf"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void stageFile(file);
              }}
            />
          </label>
        </div>
      ) : (
        <div className="pc-body" data-testid="file-pending">
          <div className="filecard">
            <Icon name="file" />
            <span className="nm" title={pending.name}>
              {pending.name}
            </span>
            <button
              className="btn ghost sm"
              onClick={() => {
                setPending(null);
                setCountry('');
              }}
            >
              {t('onboarding.providers.file.chooseAnother')}
            </button>
          </div>
          <div className="field">
            <label htmlFor="file-country">{t('onboarding.providers.file.countryLabel')}</label>
            <div className="country-input">
              <input
                id="file-country"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
              />
              {validCountry && (
                <>
                  <Flag country={country} />
                  <span className="cname">{countryName(country, i18n.language || 'en')}</span>
                </>
              )}
            </div>
            <p className="hint">{t('onboarding.providers.file.countryGuessedNote')}</p>
          </div>
          <div className="pc-actions">
            <button className="btn primary" onClick={() => void confirmImport()}>
              <Icon name="check" />
              {t('onboarding.providers.file.import')}
            </button>
          </div>
        </div>
      )}
      <ResultLine message={message} testId="file-message" />
    </CardShell>
  );
}
