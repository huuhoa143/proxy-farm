import type { AccountSecret, PortState } from '../../shared/contracts';
import type { SecretStore } from '../store/secrets';
import type { StateStore } from '../store/state';
import type { HmaLocalSource } from './hma-local';

export interface HmaCredsSyncDeps {
  source: HmaLocalSource;
  state: StateStore;
  secrets: SecretStore;
  /** Every engine/PortHealth transition (Engine.onStateChange). */
  onPortState(cb: (key: string, state: PortState) => void): () => void;
  /** Re-render and restart one port with its account's CURRENT secret (via the queue). */
  restartPort(key: string): void;
}

export interface HmaCredsSync {
  /** Re-reads the local file; returns the ids of accounts whose credentials changed. */
  check(): Promise<string[]>;
  dispose(): void;
}

const ACTIVE: ReadonlySet<PortState['kind']> = new Set(['online', 'connecting', 'verifying']);

/**
 * spec §5.1: the app watches HMA's `tokenCoreSE.json`; when `udid`/`password` really
 * change (a session renewal that only rotates the token is ignored), the new
 * credentials are applied LAZILY on each port's next (re)connect — ports are never
 * mass-restarted. A port that is already down (retrying/failed) is restarted right away
 * with the new credentials; a working one keeps running and is re-rendered only once it
 * next drops (the engine's own respawn would otherwise reuse the old rendered config).
 */
export function createHmaCredsSync(deps: HmaCredsSyncDeps): HmaCredsSync {
  const staleKeys = new Set<string>();

  async function check(): Promise<string[]> {
    const r = await deps.source.read();
    if (r.status !== 'found') return [];
    const changed: string[] = [];
    for (const account of deps.state.getState().accounts) {
      if (account.providerId !== 'hma' || account.meta.source !== 'local') continue;
      const raw = deps.secrets.loadSecret(account.secretRef);
      const current = raw ? (JSON.parse(raw) as AccountSecret) : null;
      if (current?.kind === 'userpass' && current.username === r.creds.udid && current.password === r.creds.password) continue;
      const next: AccountSecret = { kind: 'userpass', username: r.creds.udid, password: r.creds.password };
      deps.secrets.saveSecret(account.secretRef, JSON.stringify(next));
      deps.state.setState((s) => ({
        ...s,
        accounts: s.accounts.map((a) => (a.id === account.id ? { ...a, meta: { ...a.meta, udid: r.creds.udid } } : a)),
      }));
      changed.push(account.id);
    }
    for (const port of deps.state.getState().ports) {
      if (!changed.includes(port.accountId) || !port.enabled) continue;
      if (ACTIVE.has(port.state.kind)) staleKeys.add(port.key);
      else deps.restartPort(port.key);
    }
    return changed;
  }

  const unsubscribe = deps.onPortState((key, state) => {
    if (!staleKeys.has(key) || (state.kind !== 'retrying' && state.kind !== 'failed')) return;
    staleKeys.delete(key);
    deps.restartPort(key);
  });
  const unwatch = deps.source.watch(() => void check().catch(() => undefined));

  return {
    check,
    dispose() {
      unsubscribe();
      unwatch();
    },
  };
}
