import type { LogSignal } from '../../shared/contracts';

const ESTABLISHED_RE = /tunnel established to/;
const AUTH_TERMINAL_RE = /authentication failed: terminal/;

/**
 * Classifies one raw sing-box log line into a health signal (spec §6.4).
 * `'established'` for an OpenVPN tunnel coming up, `'auth-terminal'` for a
 * credential rejection sing-box itself considers unretryable. Anything else
 * (including process-exit, which the Supervisor surfaces separately) is null.
 */
export function classifyLog(line: string): LogSignal | null {
  if (AUTH_TERMINAL_RE.test(line)) return 'auth-terminal';
  if (ESTABLISHED_RE.test(line)) return 'established';
  return null;
}
