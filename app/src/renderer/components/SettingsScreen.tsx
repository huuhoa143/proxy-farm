import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi, Settings, UpdateStatus } from '../../shared/contracts';
import { changeLanguage } from '../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { useKeyedTimeouts } from '../ui/useKeyedTimeouts';
import { AboutSection } from './AboutSection';

/**
 * A text/number input that commits on blur or Enter rather than on every
 * keystroke — so settings (including the proxy password) aren't persisted
 * one character at a time. `value` is the committed value; local edits live
 * in a draft until the field is left.
 */
function CommitInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (value: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur'
>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export interface SettingsScreenProps {
  api: ProxyFarmApi;
}

/** App version inlined by vite.renderer.config.ts; `'dev'` under vitest/jsdom. */
const APP_VERSION = typeof __PROXYFARM_APP_VERSION__ !== 'undefined' ? __PROXYFARM_APP_VERSION__ : 'dev';

function Section({
  icon,
  title,
  note,
  children,
}: {
  icon: IconName;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>
          <Icon name={icon} />
          {title}
        </h2>
        {note && <p>{note}</p>}
      </div>
      <div className="set-rows">{children}</div>
    </section>
  );
}

function Row({ id, label, note, children }: { id?: string; label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div>
        {id ? (
          <label className="lbl" htmlFor={id}>
            {label}
          </label>
        ) : (
          <span className="lbl">{label}</span>
        )}
        {note && <div className="note">{note}</div>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  );
}

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

/** The human-readable note under the "Check for updates" row for the current phase. */
function updateStatusNote(update: UpdateStatus | null, t: TranslateFn): ReactNode {
  switch (update?.phase) {
    case 'checking':
      return t('settings.update.checking');
    case 'up-to-date':
      return t('settings.update.upToDate');
    case 'available':
      return t('settings.update.available', { version: update.availableVersion ?? '' });
    case 'downloading':
      return t('settings.update.downloading', { percent: Math.round(update.percent ?? 0) });
    case 'downloaded':
      return t('settings.update.downloaded');
    case 'error':
      // A localised sentence for the known failure kinds; the updater's raw (English)
      // message is only a details tooltip.
      return (
        <span data-testid="update-error" title={update.message ? t('settings.update.errorDetails', { message: update.message }) : undefined}>
          {t(`settings.update.errors.${update.errorKey ?? 'generic'}`)}
        </span>
      );
    default:
      return undefined;
  }
}

export function SettingsScreen({ api }: SettingsScreenProps) {
  const { t } = useTranslation();
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const schedule = useKeyedTimeouts();

  useEffect(() => {
    void api.getSettings().then(setSettingsState);
  }, [api]);

  // Seed from the last-known status on mount (the startup/periodic check can complete
  // before React mounts, and Electron does not buffer webContents.send), then keep the
  // live subscription for subsequent transitions.
  useEffect(() => {
    let cancelled = false;
    void api.getUpdateStatus().then((s) => {
      if (!cancelled) setUpdate((prev) => prev ?? s);
    });
    const unsubscribe = api.onUpdateStatus(setUpdate);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  async function checkForUpdate() {
    setUpdate({ phase: 'checking', currentVersion: APP_VERSION });
    setUpdate(await api.checkForUpdate());
  }

  async function patch(update: Partial<Settings>) {
    let result: Settings;
    try {
      result = await api.setSettings(update);
    } catch (err) {
      // main rejects an invalid patch with the i18n reason key as the message
      // (e.g. LAN sharing without proxy credentials). IPC prefixes it.
      const key = (err instanceof Error ? err.message : String(err)).split(': ').pop() ?? '';
      setError(t(key, { defaultValue: key }) as string);
      schedule('settings-error', () => setError(null), 5000);
      return;
    }
    setError(null);
    setSettingsState(result);
    setSaved(true);
    schedule('saved', () => setSaved(false), 2000);
  }

  function flashError(message: string) {
    setError(message);
    schedule('settings-error', () => setError(null), 5000);
  }

  /** Parse an integer text field, validating an inclusive range; shows an inline
   * error and skips the write when the value is blank, non-integer, or out of range. */
  function commitInt(raw: string, min: number, max: number, errorKey: string, apply: (n: number) => void) {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
      flashError(t(errorKey, { min, max }) as string);
      return;
    }
    apply(n);
  }

  if (!settings) return <p className="screen muted">{t('common.loading')}</p>;

  const passLabel = (showPass ? t('common.hidePassword') : t('common.showPassword')) as string;

  return (
    <div className="screen" data-testid="settings-screen">
      <div className="settings">
        <Section icon="key" title={t('settings.proxyAuth.title')} note={t('settings.proxyAuth.note')}>
          <Row id="set-user" label={t('settings.proxyAuth.username')}>
            <CommitInput
              id="set-user"
              className="mono-input"
              value={settings.proxyUser}
              spellCheck={false}
              onCommit={(v) => void patch({ proxyUser: v })}
            />
          </Row>
          <Row id="set-pass" label={t('settings.proxyAuth.password')}>
            <CommitInput
              id="set-pass"
              className="mono-input"
              type={showPass ? 'text' : 'password'}
              value={settings.proxyPass}
              spellCheck={false}
              onCommit={(v) => void patch({ proxyPass: v })}
            />
            <button className="iconbtn" onClick={() => setShowPass((v) => !v)} aria-label={passLabel} title={passLabel}>
              <Icon name="eye" />
            </button>
          </Row>
          <Row id="set-base" label={t('settings.basePort.label')} note={t('settings.basePort.note')}>
            <CommitInput
              id="set-base"
              className="num-input"
              type="number"
              min={1024}
              max={65535}
              value={String(settings.basePort)}
              onCommit={(v) => commitInt(v, 1024, 65535, 'settings.basePort.invalid', (n) => void patch({ basePort: n }))}
            />
          </Row>
        </Section>

        <Section icon="network" title={t('settings.sections.network')}>
          <Row
            id="set-lan"
            label={t('settings.lanSharing.label')}
            note={settings.lanSharing ? t('settings.lanSharing.firewallNote') : t('settings.lanSharing.offNote')}
          >
            <input
              id="set-lan"
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings.lanSharing}
              onChange={(e) => void patch({ lanSharing: e.target.checked })}
            />
          </Row>
          {settings.lanSharing && (
            <div className="callout warn" role="status" data-testid="lan-warning">
              <Icon name="alert" />
              <span>{t('settings.lanSharing.warning')}</span>
            </div>
          )}
        </Section>

        <Section icon="power" title={t('settings.sections.system')}>
          <Row id="set-awake" label={t('settings.keepAwake.label')} note={t('settings.keepAwake.note')}>
            <input
              id="set-awake"
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings.keepAwake}
              onChange={(e) => void patch({ keepAwake: e.target.checked })}
            />
          </Row>
          <Row id="set-login" label={t('settings.launchAtLogin.label')}>
            <input
              id="set-login"
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings.launchAtLogin}
              onChange={(e) => void patch({ launchAtLogin: e.target.checked })}
            />
          </Row>
          <Row
            id="set-giveup"
            label={t('settings.giveUpAfter.label')}
            note={
              settings.giveUpAfter === 0
                ? t('settings.giveUpAfter.neverNote')
                : t('settings.giveUpAfter.minutes', { count: settings.giveUpAfter })
            }
          >
            <CommitInput
              id="set-giveup"
              className="num-input"
              type="number"
              min={0}
              value={String(settings.giveUpAfter)}
              onCommit={(v) => commitInt(v, 0, 100000, 'settings.giveUpAfter.invalid', (n) => void patch({ giveUpAfter: n }))}
            />
            <span className="unit">{t('settings.giveUpAfter.unit')}</span>
          </Row>
        </Section>

        <Section icon="bolt" title={t('settings.webhook.title')} note={t('settings.webhook.offByDefaultNote')}>
          <Row id="set-hook" label={t('settings.webhook.enable')}>
            <input
              id="set-hook"
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings.webhook.enabled}
              onChange={(e) => void patch({ webhook: { ...settings.webhook, enabled: e.target.checked } })}
            />
          </Row>
          {settings.webhook.enabled && (
            <>
              <Row id="set-hook-port" label={t('settings.webhook.port')}>
                <CommitInput
                  id="set-hook-port"
                  className="num-input"
                  type="number"
                  min={1}
                  max={65535}
                  value={String(settings.webhook.port)}
                  onCommit={(v) =>
                    commitInt(v, 1, 65535, 'settings.webhook.portInvalid', (n) =>
                      void patch({ webhook: { ...settings.webhook, port: n } }),
                    )
                  }
                />
              </Row>
              <Row id="set-hook-bearer" label={t('settings.webhook.bearer')}>
                <CommitInput
                  id="set-hook-bearer"
                  className="mono-input"
                  value={settings.webhook.bearer}
                  spellCheck={false}
                  onCommit={(v) => void patch({ webhook: { ...settings.webhook, bearer: v } })}
                />
              </Row>
            </>
          )}
        </Section>

        <Section icon="globe" title={t('settings.language.label')}>
          <Row id="set-lang" label={t('settings.language.appLanguage')}>
            <select
              id="set-lang"
              value={settings.language}
              onChange={async (e) => {
                const language = e.target.value as Settings['language'];
                await patch({ language });
                await changeLanguage(language);
              }}
            >
              <option value="system">{t('common.languageSystem')}</option>
              <option value="en">{t('common.languageEnglish')}</option>
              <option value="vi">{t('common.languageVietnamese')}</option>
            </select>
          </Row>
        </Section>

        <Section icon="activity" title={t('settings.update.title')}>
          <Row label={t('settings.update.currentVersion')}>
            <span className="pill mono" data-testid="app-version">
              v{APP_VERSION}
            </span>
          </Row>
          <Row label={t('settings.update.check')} note={updateStatusNote(update, t as TranslateFn)}>
            <div className="btns">
              {/* The 'downloaded' branch is a fallback: our flow auto-fires install right
                  after the download completes (download → stop engines → quitAndInstall),
                  so the app is normally already quitting by the time this would render. It
                  stays as a safety net in case a 'downloaded' status is ever observed
                  without install firing (e.g. a future autoDownload path). */}
              {update?.phase === 'downloaded' ? (
                <button className="btn primary" onClick={() => void api.downloadAndInstallUpdate()}>
                  {t('settings.update.restartInstall')}
                </button>
              ) : update?.phase === 'available' ? (
                <button className="btn primary" data-testid="install-update" onClick={() => void api.downloadAndInstallUpdate()}>
                  {t('settings.update.downloadInstall')}
                </button>
              ) : (
                <button
                  className="btn"
                  data-testid="check-update"
                  disabled={update?.phase === 'checking' || update?.phase === 'downloading'}
                  onClick={() => void checkForUpdate()}
                >
                  {t('settings.update.check')}
                </button>
              )}
              {update?.phase === 'error' && update.releasesUrl && (
                <a className="btn link" href={update.releasesUrl} target="_blank" rel="noreferrer" data-testid="open-releases">
                  {t('settings.update.openReleases')}
                </a>
              )}
            </div>
          </Row>
          <Row id="set-autoupd" label={t('settings.update.autoCheck')} note={t('settings.update.autoCheckNote')}>
            <input
              id="set-autoupd"
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings.autoCheckUpdates}
              onChange={(e) => void patch({ autoCheckUpdates: e.target.checked })}
            />
          </Row>
        </Section>

        <AboutSection api={api} version={APP_VERSION} />
      </div>
      {error && (
        <div className="callout warn app-banner" data-testid="settings-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
      {saved && (
        <div className="toast" data-testid="settings-saved" role="status">
          <Icon name="check" />
          {t('common.saved')}
        </div>
      )}
    </div>
  );
}
