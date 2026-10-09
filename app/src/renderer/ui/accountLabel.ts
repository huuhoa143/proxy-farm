import type { TFunction } from 'i18next';

/**
 * Labels main generates for an account from a fixed English template (`providers/*`),
 * e.g. HMA's `device …<last 6 of the udid>`. They are persisted and used for duplicate
 * detection, so the stored value stays as is; only its display is localised.
 */
const TEMPLATED_LABELS: Array<{ re: RegExp; key: string }> = [
  { re: /^device …(\S+)$/, key: 'hma.deviceLabel' },
  // Surfshark/NordVPN: the end of the account's PUBLIC key.
  { re: /^pubkey …(\S+)$/, key: 'surfshark.keyLabel' },
  // Earlier builds stored the end of the PRIVATE key: never shown, whatever happens to
  // the main-process migration that relabels it.
  { re: /^key …\S+$/, key: 'surfshark.legacyKeyLabel' },
];

/**
 * Renders an account's stored label in the active UI language. Templated labels are
 * translated; anything else (an email, a host:port) is shown verbatim.
 */
export function accountLabel(t: TFunction, label: string): string {
  for (const { re, key } of TEMPLATED_LABELS) {
    const match = re.exec(label);
    if (match) return t(key, { suffix: match[1] });
  }
  return label;
}
