import type { PortState } from '../../shared/contracts';
import type { AccountPool } from '../accounts/pool';
import type { RefusalTracker } from '../accounts/refusals';
import type { StateStore } from '../store/state';

export interface RefusalWiringDeps {
  state: StateStore;
  refusals: Pick<RefusalTracker, 'classifyAuthFailure'>;
  pool: Pick<AccountPool, 'moveOnRefusal'>;
  onPortState(cb: (key: string, state: PortState) => void): () => void;
  restartPort(key: string): void;
}

/**
 * spec §5.2 + §4.2 "move a port on refusal": port-manager already records ZoogVPN auth
 * failures/online evidence in the shared refusal tracker. This turns a verdict into
 * action: a `failed(auth)` the tracker classifies as `not-in-plan` (another server on
 * the same account works) moves the port to another account and restarts it, or — if
 * no other account can take it — relabels the row `failed(not-in-plan)` so the UI shows
 * the right guidance instead of "wrong password".
 */
export function wireRefusals(deps: RefusalWiringDeps): () => void {
  return deps.onPortState((key, state) => {
    if (state.kind !== 'failed' || state.reason !== 'auth') return;
    const port = deps.state.getState().ports.find((p) => p.key === key);
    if (!port || port.providerId !== 'zoogvpn') return;
    if (deps.refusals.classifyAuthFailure(port.accountId) !== 'not-in-plan') return;
    if (deps.pool.moveOnRefusal(key)) {
      deps.restartPort(key);
      return;
    }
    deps.state.setState((s) => ({
      ...s,
      ports: s.ports.map((p) => (p.key === key ? { ...p, state: { ...state, reason: 'not-in-plan' as const } } : p)),
    }));
  });
}
