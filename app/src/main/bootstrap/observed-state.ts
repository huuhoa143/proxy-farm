import type { PortRow } from '../../shared/contracts';
import type { StateStore } from '../store/state';

/**
 * Wraps a `StateStore` so every `setState` that changes `ports` notifies `onPortsChanged`
 * (coalesced to one call per macrotask — a single start fires several state writes).
 * This is the one place the `pf:portsChanged` push, the tray's online count and the
 * keep-awake blocker learn about port changes, whoever made them (port manager, engine
 * health transitions, facade).
 */
export function observeStateStore(
  inner: StateStore,
  onPortsChanged: (rows: PortRow[]) => void,
  defer: (cb: () => void) => void = (cb) => setTimeout(cb, 0),
): StateStore {
  let pending = false;
  return {
    getState: () => inner.getState(),
    setState(mutator) {
      const before = inner.getState().ports;
      const next = inner.setState(mutator);
      if (next.ports !== before && !pending) {
        pending = true;
        defer(() => {
          pending = false;
          onPortsChanged(inner.getState().ports);
        });
      }
      return next;
    },
    secretsUnavailable: () => inner.secretsUnavailable(),
    takeSecretNotice: () => inner.takeSecretNotice(),
  };
}
