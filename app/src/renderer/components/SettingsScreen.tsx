import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi, Settings } from '../../shared/contracts';
import { changeLanguage } from '../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { useKeyedTimeouts } from '../ui/useKeyedTimeouts';

export interface SettingsScreenProps {
  api: ProxyFarmApi;
}

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

export function SettingsScreen({ api }: SettingsScreenProps) {
  const { t } = useTranslation();
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  const schedule = useKeyedTimeouts();

  useEffect(() => {
    void api.getSettings().then(setSettingsState);
  }, [api]);

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
