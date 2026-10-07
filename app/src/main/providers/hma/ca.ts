/**
 * The bundled Sectigo R46 root CA used to validate HMA's OpenVPN server cert
 * (spec §5.1: chain Sectigo OV R36 → Sectigo Public Server Authentication
 * Root R46). It's a public root certificate (self-signed, issued by and to
 * "Sectigo Limited"), extracted on macOS via:
 *
 *   security find-certificate -c "Sectigo Public Server Authentication Root R46" \
 *     -p /System/Library/Keychains/SystemRootCertificates.keychain
 *
 * and committed verbatim at app/resources/ca/sectigo-r46.pem.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../resources/ca/sectigo-r46.pem',
);

/** Returns the PEM as an array of lines (no trailing blank line), never a path. */
export function loadCaLines(caPath: string = DEFAULT_CA_PATH): string[] {
  const text = readFileSync(caPath, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}
