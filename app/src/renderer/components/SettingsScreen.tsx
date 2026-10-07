import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi, Settings, UpdateStatus } from '../../shared/contracts';
import { changeLanguage } from '../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { useKeyedTimeouts } from '../ui/useKeyedTimeouts';

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
function updateStatusNote(update: UpdateStatus | null, t: TranslateFn): string | undefined {
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
      return update.message || t('settings.update.error');
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

  // Status is pushed from main on every updater transition (check/available/progress/…).
  useEffect(() => api.onUpdateStatus(setUpdate), [api]);

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

  if (!settings) return <p className="screen muted">{t('common.loading')}</p>;

  const passLabel = (showPass ? t('common.hidePassword') : t('common.showPassword')) as string;

  return (
    <div className="screen" data-testid="settings-screen">
      <div className="settings">
        <Section icon="key" title={t('settings.proxyAuth.title')} note={t('settings.proxyAuth.note')}>
          <Row id="set-user" label={t('settings.proxyAuth.username')}>
            <input
              id="set-user"
              className="mono-input"
              value={settings.proxyUser}
              spellCheck={false}
              onChange={(e) => void patch({ proxyUser: e.target.value })}
            />
          </Row>
          <Row id="set-pass" label={t('settings.proxyAuth.password')}>
            <input
              id="set-pass"
              className="mono-input"
              type={showPass ? 'text' : 'password'}
              value={settings.proxyPass}
              spellCheck={false}
              onChange={(e) => void patch({ proxyPass: e.target.value })}
            />
            <button className="iconbtn" onClick={() => setShowPass((v) => !v)} aria-label={passLabel} title={passLabel}>
              <Icon name="eye" />
            </button>
          </Row>
          <Row id="set-base" label={t('settings.basePort.label')} note={t('settings.basePort.note')}>
            <input
              id="set-base"
              className="num-input"
              type="number"
              value={settings.basePort}
              onChange={(e) => void patch({ basePort: Number(e.target.value) })}
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
            <input
              id="set-giveup"
              className="num-input"
              type="number"
              min={0}
              value={settings.giveUpAfter}
              onChange={(e) => void patch({ giveUpAfter: Math.max(0, Number(e.target.value) || 0) })}
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
                <input
                  id="set-hook-port"
                  className="num-input"
                  type="number"
                  value={settings.webhook.port}
                  onChange={(e) => void patch({ webhook: { ...settings.webhook, port: Number(e.target.value) } })}
                />
              </Row>
              <Row id="set-hook-bearer" label={t('settings.webhook.bearer')}>
                <input
                  id="set-hook-bearer"
                  className="mono-input"
                  value={settings.webhook.bearer}
                  spellCheck={false}
                  onChange={(e) => void patch({ webhook: { ...settings.webhook, bearer: e.target.value } })}
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
