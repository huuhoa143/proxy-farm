import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi, Settings } from '../../shared/contracts';
import { changeLanguage } from '../i18n';

export interface SettingsScreenProps {
  api: ProxyFarmApi;
}

export function SettingsScreen({ api }: SettingsScreenProps) {
  const { t } = useTranslation();
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void api.getSettings().then(setSettingsState);
  }, [api]);

  async function patch(update: Partial<Settings>) {
    const result = await api.setSettings(update);
    setSettingsState(result);
    setSavedAt(Date.now());
  }

  if (!settings) return <p>{t('common.loading')}</p>;

  return (
    <div data-testid="settings-screen">
      <h1>{t('settings.title')}</h1>

      <section>
        <h2>{t('settings.proxyAuth.title')}</h2>
        <label>
          {t('settings.proxyAuth.username')}
          <input value={settings.proxyUser} onChange={(e) => patch({ proxyUser: e.target.value })} />
        </label>
        <label>
          {t('settings.proxyAuth.password')}
          <input
            type="password"
            value={settings.proxyPass}
            onChange={(e) => patch({ proxyPass: e.target.value })}
          />
        </label>
        <p className="guidance">{t('settings.proxyAuth.note')}</p>
      </section>

      <section>
        <label>
          {t('settings.basePort.label')}
          <input
            type="number"
            value={settings.basePort}
            onChange={(e) => patch({ basePort: Number(e.target.value) })}
          />
        </label>
        <p className="guidance">{t('settings.basePort.note')}</p>
      </section>

      <section>
        <label>
          <input
            type="checkbox"
            checked={settings.lanSharing}
            onChange={(e) => patch({ lanSharing: e.target.checked })}
          />
          {t('settings.lanSharing.label')}
        </label>
        {settings.lanSharing && <p className="guidance">{t('settings.lanSharing.warning')}</p>}
      </section>

      <section>
        <label>
          <input type="checkbox" checked={settings.keepAwake} onChange={(e) => patch({ keepAwake: e.target.checked })} />
          {t('settings.keepAwake.label')}
        </label>
      </section>

      <section>
        <label>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => patch({ launchAtLogin: e.target.checked })}
          />
          {t('settings.launchAtLogin.label')}
        </label>
      </section>

      <section>
        <label>
          {t('settings.giveUpAfter.label')}
          <input
            type="number"
            min={0}
            value={settings.giveUpAfter}
            onChange={(e) => patch({ giveUpAfter: Number(e.target.value) })}
          />
        </label>
        <span>{settings.giveUpAfter === 0 ? t('settings.giveUpAfter.never') : t('settings.giveUpAfter.minutes', { count: settings.giveUpAfter })}</span>
      </section>

      <section>
        <h2>{t('settings.webhook.title')}</h2>
        <p className="guidance">{t('settings.webhook.offByDefaultNote')}</p>
        <label>
          <input
            type="checkbox"
            checked={settings.webhook.enabled}
            onChange={(e) => patch({ webhook: { ...settings.webhook, enabled: e.target.checked } })}
          />
          {t('settings.webhook.enable')}
        </label>
        {settings.webhook.enabled && (
          <>
            <label>
              {t('settings.webhook.port')}
              <input
                type="number"
                value={settings.webhook.port}
                onChange={(e) => patch({ webhook: { ...settings.webhook, port: Number(e.target.value) } })}
              />
            </label>
            <label>
              {t('settings.webhook.bearer')}
              <input
                value={settings.webhook.bearer}
                onChange={(e) => patch({ webhook: { ...settings.webhook, bearer: e.target.value } })}
              />
            </label>
          </>
        )}
      </section>

      <section>
        <label>
          {t('settings.language.label')}
          <select
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
        </label>
      </section>

      {savedAt && <p data-testid="settings-saved">{t('common.saved')}</p>}
    </div>
  );
}
