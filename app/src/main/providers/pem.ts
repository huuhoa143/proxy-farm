/**
 * The lines of the first `-----BEGIN … -----END` block of a PEM-ish text file, dropping
 * anything around it (the `#` comment header of a bundled CA or OpenVPN static key).
 * Shared by the OpenVPN providers that bundle their CA files (ZoogVPN, ExpressVPN).
 */
export function linesOfPemBlock(text: string, owner: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  const end = lines.findIndex((l) => l.startsWith('-----END'));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${owner}: expected a -----BEGIN/-----END PEM block`);
  }
  return lines.slice(start, end + 1);
}
