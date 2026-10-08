import type { Settings } from '../../shared/contracts';

/** What has to happen after a settings change was accepted and persisted. */
export interface SettingsEffects {
  /** Running ports must be re-rendered: listen host or proxy credentials changed. */
  restartPorts: boolean;
  /** The webhook listener must be (re)started or stopped. */
  restartWebhook: boolean;
  refreshKeepAwake: boolean;
  launchAtLogin: boolean;
  language: boolean;
}

export function settingsEffects(prev: Settings, next: Settings): SettingsEffects {
  const lanChanged = prev.lanSharing !== next.lanSharing;
  return {
    restartPorts: lanChanged || prev.proxyUser !== next.proxyUser || prev.proxyPass !== next.proxyPass,
    restartWebhook:
      lanChanged ||
      prev.webhook.enabled !== next.webhook.enabled ||
      prev.webhook.port !== next.webhook.port ||
      prev.webhook.bearer !== next.webhook.bearer,
    refreshKeepAwake: prev.keepAwake !== next.keepAwake,
    launchAtLogin: prev.launchAtLogin !== next.launchAtLogin,
    language: prev.language !== next.language,
  };
}
