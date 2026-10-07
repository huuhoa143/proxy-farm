import { useTranslation } from 'react-i18next';

/**
 * Spec §4.3: "Another VPN is active on this computer — Proxy Farm keeps
 * working normally." Info only — never styled as a warning/error — and
 * shown only while `active` is true.
 */
export function HostVpnNote({ active }: { active: boolean }) {
  const { t } = useTranslation();
  if (!active) return null;
  return (
    <div className="vpn-note" role="status" data-testid="host-vpn-note">
      {t('vpnNote.message')}
    </div>
  );
}
