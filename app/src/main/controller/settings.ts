import type { Settings } from '../../shared/contracts';
import { generateBearer, MIN_BEARER_LENGTH } from '../webhook/index';

export interface SettingsValidationError {
  ok: false;
  reasonKey: string;
}

export interface SettingsValidationOk {
  ok: true;
  settings: Settings;
}

/**
 * Validates and normalises a `setSettings` patch against the current settings
 * (reviewer items 1 + minors):
 *  - LAN sharing with no proxy user/pass would be an OPEN proxy on the LAN (critical):
 *    rejected outright rather than silently forced back to loopback, so the user gets a
 *    clear reason instead of a setting that silently didn't take.
 *  - Enabling the webhook with an empty bearer gets a freshly generated strong one
 *    instead of running unauthenticated.
 *  - A bearer shorter than `MIN_BEARER_LENGTH` is rejected.
 */
export function applySettingsPatch(current: Settings, patch: Partial<Settings>): SettingsValidationOk | SettingsValidationError {
  const next: Settings = {
    ...current,
    ...patch,
    webhook: { ...current.webhook, ...patch.webhook },
  };

  if (next.lanSharing && (!next.proxyUser || !next.proxyPass)) {
    return { ok: false, reasonKey: 'settings.lanSharingRequiresAuth' };
  }

  if (next.webhook.enabled) {
    if (!next.webhook.bearer) {
      next.webhook = { ...next.webhook, bearer: generateBearer() };
    } else if (next.webhook.bearer.length < MIN_BEARER_LENGTH) {
      return { ok: false, reasonKey: 'settings.webhookBearerTooShort' };
    }
  }

  return { ok: true, settings: next };
}
