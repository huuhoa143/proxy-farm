import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyFarmApi, Settings } from '../../shared/contracts';
import { changeLanguage } from '../i18n';

export interface LanguageSwitchProps {
  api: ProxyFarmApi;
}

/**
 * Header-level language switch (fix item 3: language switch must also be
 * reachable outside Settings). Writes through the same `setSettings` +
 * `changeLanguage` path as the Settings screen's own language selector, so
 * the two never disagree.
 */
export function LanguageSwitch({ api }: LanguageSwitchProps) {
  const { t } = useTranslation();
  const [language, setLanguageState] = useState<Settings['language']>('system');

  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then((settings) => {
      if (!cancelled) setLanguageState(settings.language);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleChange(value: Settings['language']) {
    setLanguageState(value);
    await api.setSettings({ language: value });
    await changeLanguage(value);
  }

  return (
    <select
      aria-label={t('settings.language.label') as string}
      value={language}
      onChange={(e) => void handleChange(e.target.value as Settings['language'])}
    >
      <option value="system">{t('common.languageSystem')}</option>
      <option value="en">{t('common.languageEnglish')}</option>
      <option value="vi">{t('common.languageVietnamese')}</option>
    </select>
  );
}
