import type { PortBucket, PortCheck, PortState } from './contracts';

/**
 * The one bucket a port falls in on the main screen's status filter and in the CSV
 * export (spec §4.1 "Filters"):
 *   alive      — online, and the latest Check (if any) passed
 *   dead       — failed, retrying, or online but the latest Check failed
 *   connecting — queued, connecting, verifying
 *   stopped    — stopped
 * `check` must be a result for the port's CURRENT state (taken since it last came
 * online); the caller drops older ones.
 */
export function portBucket(state: PortState, check?: PortCheck): PortBucket {
  switch (state.kind) {
    case 'online':
      return check && !check.ok ? 'dead' : 'alive';
    case 'failed':
    case 'retrying':
      return 'dead';
    case 'stopped':
      return 'stopped';
    case 'queued':
    case 'connecting':
    case 'verifying':
      return 'connecting';
  }
}
