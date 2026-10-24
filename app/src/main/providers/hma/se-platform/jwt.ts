/** Decode a JWT's `exp` (seconds since epoch) without verifying the signature — we only
 * need to know when to refresh our own token, not to trust it. Returns undefined if the
 * token is malformed or has no numeric `exp`. */
export function jwtExpSeconds(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}
