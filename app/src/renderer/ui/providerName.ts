import type { TFunction } from 'i18next';
import type { ProviderId } from '../../shared/contracts';

/** i18n display name for a provider id ('zoogvpn' → 'ZoogVPN', 'file' → 'Config file' / 'Tệp cấu hình'). */
export function providerName(providerId: ProviderId, t: TFunction): string {
  return t(`onboarding.providers.${providerId}.name`);
}
