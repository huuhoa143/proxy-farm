import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, PortRow, ProviderId, Settings } from '../../shared/contracts';
import type { SecretStore } from './secrets';

export const SCHEMA_VERSION = 1 as const;

/**
 * Refusal bookkeeping persisted alongside the rest of state (see accounts/refusals.ts
 * for the in-memory tracker this mirrors, and its `serialize`/`hydrate` helpers). Keyed
 * by accountId, then by target/server key.
 */
export interface RefusalsState {
  /** accountId -> (targetKey -> epoch ms of the last auth failure, pruned at 7 days) */
  failures: Record<string, Record<string, number>>;
  /** accountId -> (targetKey -> epoch ms last seen online, pruned like a failure) */
  online: Record<string, Record<string, number>>;
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

/** Secret-store ids `settings.proxyPass` / `settings.webhook.bearer` are kept under —
 * these two fields are never written to state.json in plaintext (reviewer item 4). */
export const PROXY_PASS_SECRET_ID = 'settings:proxyPass';
export const WEBHOOK_BEARER_SECRET_ID = 'settings:webhook:bearer';
/** A placeholder written to disk in the two fields' place, so an old plaintext file
 * (pre-dating this change) is still recognisably "has a value, go look it up" vs "truly
 * empty" is not needed — the secret store is always the source of truth once a secret
 * exists under the id above; this is purely cosmetic for anyone reading state.json. */
const SECRET_PLACEHOLDER = '<secret>';

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
  /** Injectable clock, used only to name a corrupt-file backup uniquely. */
  now?: () => number;
}

/** Fills in any field missing from a loaded (possibly older/partial/hand-edited) file
 * with the current defaults, one level deep for `settings`/`settings.webhook`. This is
 * the one and only "migration" today (schema is still version 1); a future version
 * bump adds real field renames/moves here, keyed off the *old* `schemaVersion`. */
function fillDefaults(raw: Partial<AppState> | undefined, randomPass?: () => string): AppState {
  const defaults = defaultState(randomPass);
  const rawSettings = (raw?.settings ?? {}) as Partial<Settings>;
  return {
    schemaVersion: SCHEMA_VERSION,
    ports: Array.isArray(raw?.ports) ? raw!.ports : defaults.ports,
    accounts: Array.isArray(raw?.accounts) ? raw!.accounts : defaults.accounts,
    limits: raw?.limits && typeof raw.limits === 'object' ? (raw.limits as Record<ProviderId, number>) : defaults.limits,
    refusals:
      raw?.refusals && typeof raw.refusals === 'object'
        ? { failures: raw.refusals.failures ?? {}, online: raw.refusals.online ?? {} }
        : defaults.refusals,
    portServers: raw?.portServers && typeof raw.portServers === 'object' ? raw.portServers : defaults.portServers,
    settings: {
      ...defaults.settings,
      ...rawSettings,
      webhook: { ...defaults.settings.webhook, ...(rawSettings.webhook ?? {}) },
    },
  };
}

/**
 * JSON state file at `filePath`, schema-versioned, written atomically (temp file in the
 * same directory, fsync'd, then renamed over the target — the rename is what's atomic;
 * the fsync makes sure the temp file's bytes actually hit disk first). `getState` lazily
 * creates the file with defaults on first use; a file with an unknown/missing
 * `schemaVersion` or that fails to parse is backed up (best-effort) and replaced with
 * defaults rather than crashing the app. `setState` reads the current value, applies
 * `mutator`, persists, and returns the new state.
 *
 * `secrets` keeps `settings.proxyPass` and `settings.webhook.bearer` out of the
 * plaintext JSON file (reviewer item 4): they are read back from the secret store on
 * load and written there (not into `state.json`) on every save.
 */
export function createStateStore(filePath: string, secrets: SecretStore, options: CreateStateStoreOptions = {}): StateStore {
  let cached: AppState | null = null;
  const now = options.now ?? Date.now;

  function backupCorruptFile(reason: string): void {
    try {
      const backupPath = `${filePath}.corrupt-${now()}`;
      renameSync(filePath, backupPath);
      // eslint-disable-next-line no-console
      console.error(`[state] ${filePath} ${reason}; backed up to ${backupPath} and starting from defaults`);
    } catch {
      // best-effort only — if even the rename fails, we still fall through to defaults
    }
  }

  function resolveSecrets(state: AppState): AppState {
    const proxyPass = secrets.loadSecret(PROXY_PASS_SECRET_ID) ?? state.settings.proxyPass;
    const bearer = secrets.loadSecret(WEBHOOK_BEARER_SECRET_ID) ?? state.settings.webhook.bearer;
    return { ...state, settings: { ...state.settings, proxyPass, webhook: { ...state.settings.webhook, bearer } } };
  }

  function readFromDisk(): AppState {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return initializeDefaults();
    }

    let parsed: Partial<AppState> | undefined;
    try {
      parsed = JSON.parse(raw) as Partial<AppState>;
    } catch {
      backupCorruptFile('failed to parse as JSON');
      return initializeDefaults();
    }

    if (typeof parsed !== 'object' || parsed === null) {
      backupCorruptFile('did not contain a JSON object');
      return initializeDefaults();
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      backupCorruptFile(`had schemaVersion ${JSON.stringify(parsed.schemaVersion)}, expected ${SCHEMA_VERSION}`);
      return initializeDefaults();
    }

    const filled = fillDefaults(parsed, options.randomPass);
    const resolved = resolveSecrets(filled);
    persist(resolved);
    return resolved;
  }

  function initializeDefaults(): AppState {
    const initial = resolveSecrets(defaultState(options.randomPass));
    persist(initial);
    return initial;
  }

  function persist(state: AppState): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    // Secrets never touch the JSON file: save them to the secret store, and write a
    // placeholder in their place on disk.
    secrets.saveSecret(PROXY_PASS_SECRET_ID, state.settings.proxyPass);
    secrets.saveSecret(WEBHOOK_BEARER_SECRET_ID, state.settings.webhook.bearer);
    const onDisk: AppState = {
      ...state,
      settings: { ...state.settings, proxyPass: SECRET_PLACEHOLDER, webhook: { ...state.settings.webhook, bearer: SECRET_PLACEHOLDER } },
    };

    const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    let fd: number | undefined;
    try {
      fd = openSync(tmpPath, 'w');
      writeSync(fd, JSON.stringify(onDisk, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, filePath);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* best effort cleanup */
      }
      throw err;
    }
    cached = state; // the in-memory copy keeps the real plaintext secrets
  }

  function getState(): AppState {
    if (cached) return cached;
    if (existsSync(filePath)) {
      cached = readFromDisk();
      return cached;
    }
    cached = initializeDefaults();
    return cached;
  }

  function setState(mutator: (state: AppState) => AppState): AppState {
    const current = getState();
    const next = mutator(current);
    persist(next);
    return next;
  }

  return { getState, setState };
}
