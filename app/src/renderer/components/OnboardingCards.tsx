import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckResult, ProviderId, ProxyFarmApi } from '../../shared/contracts';
import { Icon } from '../ui/Icon';
import { Flag } from '../ui/Flag';
import { countryName } from '../ui/countryName';
import { accountLabel } from '../ui/accountLabel';

interface Message {
  ok: boolean;
  text: string;
}

function resultMessage(t: ReturnType<typeof useTranslation>['t'], result: CheckResult): Message {
  if (result.ok) {
    const text = result.label ? accountLabel(t, result.label) : (t('checkResult.ok') as string);
    // Accepted with a caveat (e.g. the login could not be checked live just now).
    return { ok: true, text: result.noteKey ? `${text} — ${t(result.noteKey, { defaultValue: result.noteKey })}` : text };
  }
  const key = result.reasonKey ?? 'checkResult.reason.invalid-format';
  return { ok: false, text: t(key, { defaultValue: key, label: result.label ?? '' }) as string };
}

/** Turn a rejected IPC call into a user-facing message (main throws an i18n key). */
function errorMessage(t: ReturnType<typeof useTranslation>['t'], err: unknown): Message {
  const raw = err instanceof Error ? err.message : String(err);
  const key = raw.split(': ').pop() || raw || 'checkResult.reason.invalid-format';
  return { ok: false, text: t(key, { defaultValue: key }) as string };
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
    } catch (err) {
      setMessage(errorMessage(t, err));
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
    } catch (err) {
      setMessage(errorMessage(t, err));
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
    } catch (err) {
      setMessage(errorMessage(t, err));
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
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // A pasted/imported .conf carries its own Address, so the field would be ignored.
  const isConf = /\[\s*interface\s*\]/i.test(key);

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const input: Record<string, string> = isConf ? { config: key } : { privateKey: key.trim(), address: address.trim() };
      const result = await api.addAccount('surfshark', input);
      setMessage(resultMessage(t, result));
      if (result.ok) onAdded();
    } catch (err) {
      setMessage(errorMessage(t, err));
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
      <div className="field">
        <label htmlFor="surfshark-address">{t('onboarding.providers.surfshark.addressLabel')}</label>
        <input
          id="surfshark-address"
          type="text"
          inputMode="decimal"
          spellCheck={false}
          placeholder={t('onboarding.providers.surfshark.addressPlaceholder') as string}
          value={isConf ? '' : address}
          disabled={isConf}
          onChange={(e) => setAddress(e.target.value)}
        />
        <p className="hint" data-testid="surfshark-address-hint">
          {isConf ? t('onboarding.providers.surfshark.addressFromConf') : t('onboarding.providers.surfshark.addressHint')}
        </p>
      </div>
      <div className="pc-actions">
        <label className="btn sm">
          <Icon name="upload" />
          {t('onboarding.providers.surfshark.importConf')}
          <input
            type="file"
            accept=".conf"
            className="sr-only"
            data-testid="surfshark-conf-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setKey);
              e.target.value = '';
            }}
          />
        </label>
        <button className="btn primary" onClick={add} disabled={busy || key.trim().length < 10}>
          <Icon name="key" />
          {t('onboarding.providers.surfshark.add')}
        </button>
      </div>
      <ResultLine message={message} testId="surfshark-message" />
    </CardShell>
  );
}

export interface NordVpnCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
  accountCount?: number;
}

/** spec §5.5: one field takes a Nord Account access token (exchanged once in main, never
 * stored) or the NordLynx private key itself. Masked: both are secrets. */
export function NordVpnCard({ api, onAdded, accountCount }: NordVpnCardProps) {
  const { t } = useTranslation();
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.addAccount('nordvpn', { credential: credential.trim() });
      setMessage(resultMessage(t, result));
      if (result.ok) {
        setCredential('');
        onAdded();
      }
    } catch (err) {
      setMessage(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell providerId="nordvpn" accountCount={accountCount}>
      <form
        className="pc-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && credential.trim()) void add();
        }}
      >
        <div className="field">
          <label htmlFor="nordvpn-credential">{t('onboarding.providers.nordvpn.credentialLabel')}</label>
          <input
            id="nordvpn-credential"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('onboarding.providers.nordvpn.credentialPlaceholder') as string}
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
          <p className="hint">
            {t('onboarding.providers.nordvpn.hintLead')}{' '}
            <span className="path">{t('onboarding.providers.nordvpn.hintPath')}</span>
          </p>
          <p className="hint">{t('onboarding.providers.nordvpn.hintStored')}</p>
        </div>
        <div className="pc-actions">
          <button className="btn primary" type="submit" disabled={busy || !credential.trim()}>
            <Icon name="key" />
            {busy ? t('onboarding.providers.nordvpn.adding') : t('onboarding.providers.nordvpn.add')}
          </button>
        </div>
      </form>
      <ResultLine message={message} testId="nordvpn-message" />
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

/** An `.ovpn` that signs in with a username and password (a bare `auth-user-pass` line). */
function needsSignIn(file: PendingFile): boolean {
  return /\.ovpn$/i.test(file.name) && /^\s*auth-user-pass\s*$/m.test(file.content);
}

export function FileCard({ api, onAdded, accountCount }: FileCardProps) {
  const { t, i18n } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [country, setCountry] = useState('');
  const [busy, setBusy] = useState(false);
  // The VPN username/password an `.ovpn` with `auth-user-pass` signs in with (spec §5.4).
  const [askSignIn, setAskSignIn] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function reset() {
    setPending(null);
    setCountry('');
    setAskSignIn(false);
    setUsername('');
    setPassword('');
  }

  async function stageFile(file: File) {
    const content = await file.text();
    const staged = { name: file.name, content };
    setPending(staged);
    setCountry(guessCountryFromFilename(file.name));
    setAskSignIn(needsSignIn(staged));
    setMessage(null);
  }

  const validCountry = /^[A-Z]{2}$/.test(country);
  const signInReady = !askSignIn || (username.trim() !== '' && password !== '');

  async function confirmImport() {
    if (!pending) return;
    // Validate the country in the UI before the IPC call: a blank or 1-letter
    // code would otherwise reach the backend (or import an un-flagged location).
    if (!validCountry) {
      setMessage({ ok: false, text: t('onboarding.providers.file.countryInvalid') as string });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = askSignIn
        ? await api.importConfigFile(pending.name, pending.content, country, { username: username.trim(), password })
        : await api.importConfigFile(pending.name, pending.content, country);
      setMessage(resultMessage(t, result));
      if (result.ok) {
        reset();
        onAdded();
      } else if (result.reasonKey === 'file.check.needsCredentials') {
        setAskSignIn(true);
      }
    } catch (err) {
      setMessage(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

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
            <button className="btn ghost sm" onClick={reset}>
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
            {country !== '' && !validCountry && (
              <p className="hint bad" data-testid="file-country-invalid">
                {t('onboarding.providers.file.countryInvalid')}
              </p>
            )}
          </div>
          {askSignIn && (
            <div className="pc-body" data-testid="file-credentials">
              <div className="field">
                <label htmlFor="file-username">{t('onboarding.providers.file.username')}</label>
                <input
                  id="file-username"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="file-password">{t('onboarding.providers.file.password')}</label>
                <input
                  id="file-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="hint">{t('onboarding.providers.file.signInNote')}</p>
              </div>
            </div>
          )}
          <div className="pc-actions">
            <button
              className="btn primary"
              disabled={busy || !validCountry || !signInReady}
              onClick={() => void confirmImport()}
            >
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
