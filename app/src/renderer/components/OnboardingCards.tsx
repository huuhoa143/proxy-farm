import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckResult, ProxyFarmApi } from '../../shared/contracts';

function resultMessage(t: ReturnType<typeof useTranslation>['t'], result: CheckResult): string {
  if (result.ok) return result.label ? result.label : (t('checkResult.ok') as string);
  const key = result.reasonKey ?? 'checkResult.reason.invalid-format';
  return t(key, { defaultValue: key }) as string;
}

export interface HmaCardProps {
  api: ProxyFarmApi;
  detected: boolean;
  onAdded: () => void;
}

export function HmaCard({ api, detected, onAdded }: HmaCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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

  return (
    <div className="provider-card" data-testid="provider-card-hma">
      <h3>{t('onboarding.providers.hma.name')}</h3>
      <p>{t('onboarding.providers.hma.description')}</p>
      {detected ? (
        <>
          <p data-testid="hma-detected">{t('onboarding.providers.hma.detectedTitle')}</p>
          <p className="guidance">{t('onboarding.providers.hma.detectedSubtitle')}</p>
          <button className="btn primary" onClick={connect} disabled={busy}>
            {busy ? t('onboarding.providers.hma.connecting') : t('onboarding.providers.hma.connect')}
          </button>
        </>
      ) : (
        <>
          <p data-testid="hma-not-detected">{t('onboarding.providers.hma.notDetectedTitle')}</p>
          <ol className="guidance">
            <li>{t('onboarding.providers.hma.step1')}</li>
            <li>{t('onboarding.providers.hma.step2')}</li>
            <li>{t('onboarding.providers.hma.step3')}</li>
          </ol>
          <button className="btn primary" onClick={connect} disabled={busy}>
            {t('onboarding.providers.hma.enableSupport')}
          </button>
          <p className="guidance">{t('onboarding.providers.hma.windowsHelperNote')}</p>
        </>
      )}
      {message && <p data-testid="hma-message">{message}</p>}
    </div>
  );
}

export interface ZoogVpnCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
}

export function ZoogVpnCard({ api, onAdded }: ZoogVpnCardProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    <div className="provider-card" data-testid="provider-card-zoogvpn">
      <h3>{t('onboarding.providers.zoogvpn.name')}</h3>
      <p>{t('onboarding.providers.zoogvpn.description')}</p>
      <input
        aria-label={t('onboarding.providers.zoogvpn.email') as string}
        placeholder={t('onboarding.providers.zoogvpn.emailPlaceholder') as string}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        aria-label={t('onboarding.providers.zoogvpn.password') as string}
        placeholder={t('onboarding.providers.zoogvpn.passwordPlaceholder') as string}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn primary" onClick={check} disabled={busy || !email || !password}>
        {busy ? t('onboarding.providers.zoogvpn.checking') : t('onboarding.providers.zoogvpn.check')}
      </button>
      {message && <p data-testid="zoogvpn-message">{message}</p>}
    </div>
  );
}

export interface SurfsharkCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
}

export function SurfsharkCard({ api, onAdded }: SurfsharkCardProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    <div className="provider-card" data-testid="provider-card-surfshark">
      <h3>{t('onboarding.providers.surfshark.name')}</h3>
      <p>{t('onboarding.providers.surfshark.description')}</p>
      <textarea
        aria-label={t('onboarding.providers.surfshark.keyLabel') as string}
        placeholder={t('onboarding.providers.surfshark.keyPlaceholder') as string}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <p className="guidance">{t('onboarding.providers.surfshark.hint')}</p>
      <button className="btn primary" onClick={add} disabled={busy || key.length < 10}>
        {t('onboarding.providers.surfshark.add')}
      </button>
      {message && <p data-testid="surfshark-message">{message}</p>}
    </div>
  );
}

export interface FileCardProps {
  api: ProxyFarmApi;
  onAdded: () => void;
}

export function FileCard({ api, onAdded }: FileCardProps) {
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function importFile(file: File) {
    const content = await file.text();
    const result = await api.importConfigFile(file.name, content);
    setMessage(resultMessage(t, result));
    if (result.ok) onAdded();
  }

  return (
    <div className="provider-card" data-testid="provider-card-file">
      <h3>{t('onboarding.providers.file.name')}</h3>
      <p>{t('onboarding.providers.file.description')}</p>
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
          if (file) void importFile(file);
        }}
      >
        <p>{t('onboarding.providers.file.dragHint')}</p>
        <label className="btn ghost">
          {t('onboarding.providers.file.browse')}
          <input
            type="file"
            accept=".ovpn,.conf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
        </label>
      </div>
      {message && <p data-testid="file-message">{message}</p>}
    </div>
  );
}
