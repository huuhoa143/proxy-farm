import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, PortRow, ProviderId, Settings } from '../../shared/contracts';

export const SCHEMA_VERSION = 1 as const;

/**
 * Refusal bookkeeping persisted alongside the rest of state (see accounts/refusals.ts
 * for the in-memory tracker this mirrors). Keyed by accountId, then by target/server key.
 */
export interface RefusalsState {
  /** accountId -> (targetKey -> epoch ms of the last auth failure, pruned at 7 days) */
  failures: Record<string, Record<string, number>>;
  /** accountId -> set of targetKeys last seen online (presence = truthy) */
  online: Record<string, Record<string, true>>;
}

export interface AppState {
  schemaVersion: typeof SCHEMA_VERSION;
  ports: PortRow[];
  settings: Settings;
  accounts: Account[];
  limits: Record<ProviderId, number>;
  refusals: RefusalsState;
  /**
   * Controller-internal bookkeeping, not part of the spec's named shape but needed to
   * implement rotate (§6.5): the server IP currently bound to each port's key, so
   * "another IP of the same location" can be computed. Not relied on by other modules.
   */
  portServers: Record<string, string>;
}

export function defaultSettings(randomPass: () => string = defaultRandomPass): Settings {
  return {
    proxyUser: 'proxy',
    proxyPass: randomPass(),
    basePort: 29001,
    lanSharing: false,
    keepAwake: true,
    launchAtLogin: false,
    giveUpAfter: 0,
    webhook: { enabled: false, port: 0, bearer: '' },
    language: 'system',
  };
}

function defaultRandomPass(): string {
  return randomBytes(9).toString('base64url');
}

export function defaultState(randomPass?: () => string): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    ports: [],
    settings: defaultSettings(randomPass),
    accounts: [],
    limits: {} as Record<ProviderId, number>,
    refusals: { failures: {}, online: {} },
    portServers: {},
  };
}

export interface StateStore {
  getState(): AppState;
  setState(mutator: (state: AppState) => AppState): AppState;
}

export interface CreateStateStoreOptions {
  /** Injectable for tests; defaults to a cryptographically random password. */
  randomPass?: () => string;
}

/**
 * JSON state file at `filePath`, schema-versioned, written atomically (temp file in the
 * same directory + rename). `getState` lazily creates the file with defaults on first
 * use. `setState` reads the current value, applies `mutator`, persists, and returns the
 * new state.
 */
export function createStateStore(filePath: string, options: CreateStateStoreOptions = {}): StateStore {
  let cached: AppState | null = null;

  function readFromDisk(): AppState {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as AppState;
  }

  function persist(state: AppState): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, filePath);
    cached = state;
  }

  function getState(): AppState {
    if (cached) return cached;
    if (existsSync(filePath)) {
      cached = readFromDisk();
      return cached;
    }
    const initial = defaultState(options.randomPass);
    persist(initial);
    return initial;
  }

  function setState(mutator: (state: AppState) => AppState): AppState {
    const current = getState();
    const next = mutator(current);
    persist(next);
    return next;
  }

  return { getState, setState };
}
