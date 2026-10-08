import { randomBytes } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { makePortKey, type Account, type PortRow, type ProviderId, type Settings } from '../../shared/contracts';
import type { SecretStore } from './secrets';

/** v2 (spec §6.8, rev 3): port keys are `<locationKey>#<n>`, each row pins its own
 * `server`, and server health (refused / last OK) is persisted per (account, server). */
export const SCHEMA_VERSION = 2 as const;

/**
 * Refusal bookkeeping persisted alongside the rest of state (see accounts/refusals.ts
 * for the in-memory tracker this mirrors, and its `serialize`/`hydrate` helpers). Keyed
 * by accountId, then by server token (v1 keyed it by target key).
 */
export interface RefusalsState {
  /** accountId -> (server -> epoch ms of the last auth failure, pruned at 7 days) */
  failures: Record<string, Record<string, number>>;
  /** accountId -> (server -> epoch ms last seen online, pruned like a failure) */
  online: Record<string, Record<string, number>>;
}

/**
 * The persisted half of the per-(account, server) health in spec §6.8 (see
 * controller/server-health.ts). `dead until` is deliberately not here: it is a 2 h
 * in-memory hint.
 */
export interface ServerHealthState {
  /** accountId -> (server -> epoch ms the refusal expires, 7 days after it was seen) */
  refused: Record<string, Record<string, number>>;
  /** accountId -> (server -> epoch ms the server was last confirmed online) */
  lastOk: Record<string, Record<string, number>>;
}

export interface AppState {
  schemaVersion: typeof SCHEMA_VERSION;
  ports: PortRow[];
  settings: Settings;
  accounts: Account[];
  limits: Record<ProviderId, number>;
  refusals: RefusalsState;
  serverHealth: ServerHealthState;
  /** Old location key → the location its ports were re-attached to at boot (spec §6.8),
   * so the webhook still resolves a retired bare location key (spec §6.6). */
  locationAliases: Record<string, string>;
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
    // Vietnamese by default (owner decision); 'system' and 'en' remain user choices.
    language: 'vi',
    autoCheckUpdates: true,
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
    serverHealth: { refused: {}, lastOk: {} },
    locationAliases: {},
  };
}

export interface StateStore {
  getState(): AppState;
  setState(mutator: (state: AppState) => AppState): AppState;
  /** True once a secret write has been observed to fail (`safeStorage` encryption
   * unavailable on this platform/session) — the UI can poll this to show a persistent
   * warning. Secrets still work in-memory for the running session; only the on-disk
   * ciphertext is missing, so a restart would lose them (reviewer item 4). */
  secretsUnavailable(): boolean;
  /** Returns, and clears, a one-time human-readable notice set when a loaded file's
   * proxyPass/webhook bearer could not be resolved from the secret store and had to be
   * regenerated/disabled (reviewer item 4). `null` when there is nothing to show. */
  takeSecretNotice(): string | null;
}

export interface CreateStateStoreOptions {
  /** Injectable for tests; defaults to a cryptographically random password. */
  randomPass?: () => string;
  /** Injectable clock, used only to name a corrupt-file backup uniquely. */
  now?: () => number;
}

/** The fields of a v1 file that v2 no longer has (spec §6.8 migration). */
interface V1Fields {
  portServers?: Record<string, string>;
}

type LoadedState = Partial<Omit<AppState, 'schemaVersion'>> & V1Fields & { schemaVersion?: unknown };

function nestedRecord(raw: unknown): Record<string, Record<string, number>> {
  return raw && typeof raw === 'object' ? (raw as Record<string, Record<string, number>>) : {};
}

/**
 * v1 → v2 (spec §6.8): every row `K` becomes `K#1` with `locationKey = K`, and
 * `portServers[K]` becomes that row's `server`. Everything else on the row (proxy port,
 * account, auto-rotate, enabled) carries over unchanged. Refusal evidence was keyed by
 * target key; it is re-keyed by the server that target last ran on, and dropped where
 * that is unknown (it is only a 7-day hint).
 */
function migrateV1(raw: LoadedState): LoadedState {
  const portServers = raw.portServers && typeof raw.portServers === 'object' ? raw.portServers : {};
  const ports = Array.isArray(raw.ports)
    ? raw.ports.map((p) => {
        const server = portServers[p.key] ?? p.server;
        return { ...p, key: makePortKey(p.key, 1), locationKey: p.key, ...(server ? { server } : {}) };
      })
    : raw.ports;
  const rekey = (byAccount: Record<string, Record<string, number>>): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = {};
    for (const [accountId, byKey] of Object.entries(byAccount)) {
      for (const [key, at] of Object.entries(byKey)) {
        const server = portServers[key];
        if (server) (out[accountId] ??= {})[server] = at;
      }
    }
    return out;
  };
  const refusals =
    raw.refusals && typeof raw.refusals === 'object'
      ? { failures: rekey(nestedRecord(raw.refusals.failures)), online: rekey(nestedRecord(raw.refusals.online)) }
      : raw.refusals;
  const { portServers: _dropped, ...rest } = raw;
  return { ...rest, ports, refusals };
}

/**
 * What is left of a file whose v1 → v2 migration threw (malformed rows or refusal
 * records): the accounts (their secrets are keyed by account id, so dropping them would
 * orphan every credential), settings and limits. Ports, refusal evidence and server
 * health are dropped; the original is kept in the `.v1.bak` copy.
 */
function salvageUnmigratable(raw: LoadedState): LoadedState {
  return { schemaVersion: SCHEMA_VERSION, accounts: raw.accounts, settings: raw.settings, limits: raw.limits };
}

/** Fills in any field missing from a loaded (possibly older/partial/hand-edited) file
 * with the current defaults, one level deep for `settings`/`settings.webhook`, after
 * migrating a v1 (or version-less) file with `migrateV1`. */
function fillDefaults(loaded: LoadedState | undefined, randomPass?: () => string): AppState {
  const defaults = defaultState(randomPass);
  const raw = loaded && loaded.schemaVersion !== SCHEMA_VERSION ? migrateV1(loaded) : loaded;
  const rawSettings = (raw?.settings ?? {}) as Partial<Settings>;
  const rawHealth = raw?.serverHealth;
  return {
    schemaVersion: SCHEMA_VERSION,
    ports: Array.isArray(raw?.ports) ? raw!.ports : defaults.ports,
    accounts: Array.isArray(raw?.accounts) ? raw!.accounts : defaults.accounts,
    limits: raw?.limits && typeof raw.limits === 'object' ? (raw.limits as Record<ProviderId, number>) : defaults.limits,
    refusals:
      raw?.refusals && typeof raw.refusals === 'object'
        ? { failures: raw.refusals.failures ?? {}, online: raw.refusals.online ?? {} }
        : defaults.refusals,
    serverHealth:
      rawHealth && typeof rawHealth === 'object'
        ? { refused: nestedRecord(rawHealth.refused), lastOk: nestedRecord(rawHealth.lastOk) }
        : defaults.serverHealth,
    locationAliases:
      raw?.locationAliases && typeof raw.locationAliases === 'object' && !Array.isArray(raw.locationAliases)
        ? raw.locationAliases
        : defaults.locationAliases,
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
  const randomPass = options.randomPass ?? defaultRandomPass;

  // Secret-write failure/availability bookkeeping (reviewer item 4).
  let secretsUnavailableFlag = false;
  let pendingSecretNotice: string | null = null;
  // Only re-encrypt-and-write a secret file when its value actually changed (reviewer
  // minor): `undefined` so the very first `persist()` after a fresh load/init always
  // writes once (ensuring the secret store actually holds what was just resolved).
  let lastSavedProxyPass: string | undefined;
  let lastSavedBearer: string | undefined;

  function trySaveSecret(id: string, value: string, lastSaved: string | undefined, setLastSaved: (v: string) => void): void {
    if (value === lastSaved) return;
    try {
      secrets.saveSecret(id, value);
      setLastSaved(value);
      secretsUnavailableFlag = false;
    } catch (err) {
      // `safeStorage` encryption unavailable (or some other write failure): keep the
      // secret in memory for this session rather than let it crash every `setState`
      // (reviewer item 4) — `state.json`'s non-secret fields still get written below.
      secretsUnavailableFlag = true;
      // eslint-disable-next-line no-console
      console.error(`[state] failed to save secret ${id}; keeping it in memory for this session only`, err);
    }
  }

  function appendNotice(existing: string | null, msg: string): string {
    return existing ? `${existing} ${msg}` : msg;
  }

  /** Before the first v2 write over a v1 file: keep the original as `state.json.v1.bak`.
   * Only once — a later migration (e.g. after a downgrade) never overwrites that copy. */
  function backupV1File(): void {
    try {
      copyFileSync(filePath, `${filePath}.v1.bak`, constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return;
      // eslint-disable-next-line no-console
      console.error(`[state] could not back up ${filePath} before migrating it`, err);
    }
  }

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

  /** For a brand-new install: nothing has ever been saved to the secret store yet, so
   * `state.settings.proxyPass`/`.bearer` here are the just-generated real defaults (not
   * an on-disk placeholder) — falling back to them when `loadSecret` returns null (the
   * expected first-run case) is safe. */
  function resolveSecretsForFreshState(state: AppState): AppState {
    const proxyPass = secrets.loadSecret(PROXY_PASS_SECRET_ID) ?? state.settings.proxyPass;
    const bearer = secrets.loadSecret(WEBHOOK_BEARER_SECRET_ID) ?? state.settings.webhook.bearer;
    return { ...state, settings: { ...state.settings, proxyPass, webhook: { ...state.settings.webhook, bearer } } };
  }

  /**
   * Resolves `settings.proxyPass`/`settings.webhook.bearer` for a file loaded FROM DISK,
   * where — unlike a fresh install — `state.settings.proxyPass`/`.bearer` are the literal
   * on-disk `SECRET_PLACEHOLDER` string whenever the real values live only in the secret
   * store (reviewer item 4 — SECURITY). A failed/missing `loadSecret` must NEVER fall
   * back to those fields: silently treating the placeholder string as a real password
   * (or leaving a dead placeholder standing in for a real bearer) would hand out a
   * fixed, guessable credential to anyone who can reach the proxy port/webhook. Instead:
   * a missing proxyPass is replaced with a freshly generated random one (persisted back
   * to the secret store on the next `persist()`); a missing webhook bearer disables the
   * webhook outright rather than run it under a credential nobody holds. Either case
   * records a one-time notice retrievable via `takeSecretNotice()`.
   */
  function resolveLoadedSecrets(state: AppState): AppState {
    let notice: string | null = null;

    const loadedProxyPass = secrets.loadSecret(PROXY_PASS_SECRET_ID);
    let proxyPass = loadedProxyPass;
    if (proxyPass === null) {
      proxyPass = randomPass();
      notice = appendNotice(notice, 'Your proxy password could not be read back securely and was reset to a new random one.');
    }

    const loadedBearer = secrets.loadSecret(WEBHOOK_BEARER_SECRET_ID);
    const bearerMissing = loadedBearer === null;
    const bearer = bearerMissing ? '' : loadedBearer;
    const webhookEnabled = bearerMissing ? false : state.settings.webhook.enabled;
    if (bearerMissing && state.settings.webhook.enabled) {
      notice = appendNotice(
        notice,
        'The rotate webhook could not read its bearer token back securely and was turned off; re-enable it to generate a new one.',
      );
    }

    if (notice) pendingSecretNotice = appendNotice(pendingSecretNotice, notice);

    return {
      ...state,
      settings: { ...state.settings, proxyPass, webhook: { ...state.settings.webhook, bearer, enabled: webhookEnabled } },
    };
  }

  function readFromDisk(): AppState {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return initializeDefaults();
    }

    let parsed: LoadedState | undefined;
    try {
      parsed = JSON.parse(raw) as LoadedState;
    } catch {
      backupCorruptFile('failed to parse as JSON');
      return initializeDefaults();
    }

    if (typeof parsed !== 'object' || parsed === null) {
      backupCorruptFile('did not contain a JSON object');
      return initializeDefaults();
    }
    // A file whose `schemaVersion` is missing entirely (predates the field, or was
    // produced/hand-edited by something that forgot to set it) is NOT corrupt — treat it
    // as v1 and migrate via `fillDefaults` below, same as any other partial/old file
    // (reviewer item 10). Only a version this build does not know — a real, unhandled
    // future/unknown schema — is backed up and discarded.
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1 && parsed.schemaVersion !== SCHEMA_VERSION) {
      backupCorruptFile(`had schemaVersion ${JSON.stringify(parsed.schemaVersion)}, expected ${SCHEMA_VERSION}`);
      return initializeDefaults();
    }

    if (parsed.schemaVersion !== SCHEMA_VERSION) backupV1File();
    let filled: AppState;
    try {
      filled = fillDefaults(parsed, options.randomPass);
    } catch (err) {
      // A malformed v1 file: start over like a corrupt one, but keep its accounts (and
      // settings) — the original stays in the `.v1.bak` copy taken above.
      // eslint-disable-next-line no-console
      console.error(`[state] ${filePath} could not be migrated; kept its accounts and settings, dropped its ports`, err);
      filled = fillDefaults(salvageUnmigratable(parsed), options.randomPass);
      pendingSecretNotice = appendNotice(
        pendingSecretNotice,
        `Your saved ports could not be carried over from the previous version and were cleared; your accounts and settings were kept. The old file is at ${filePath}.v1.bak.`,
      );
    }
    const resolved = resolveLoadedSecrets(filled);
    persist(resolved);
    return resolved;
  }

  function initializeDefaults(): AppState {
    const initial = resolveSecretsForFreshState(defaultState(options.randomPass));
    persist(initial);
    return initial;
  }

  function persist(state: AppState): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    // Secrets never touch the JSON file: save them to the secret store (skipping the
    // write if unchanged since the last successful save — reviewer minor), and write a
    // placeholder in their place on disk regardless of whether that save succeeded (the
    // real value still lives in memory for this session either way — reviewer item 4).
    trySaveSecret(PROXY_PASS_SECRET_ID, state.settings.proxyPass, lastSavedProxyPass, (v) => (lastSavedProxyPass = v));
    trySaveSecret(WEBHOOK_BEARER_SECRET_ID, state.settings.webhook.bearer, lastSavedBearer, (v) => (lastSavedBearer = v));
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

  return {
    getState,
    setState,
    secretsUnavailable: () => secretsUnavailableFlag,
    takeSecretNotice: () => {
      const notice = pendingSecretNotice;
      pendingSecretNotice = null;
      return notice;
    },
  };
}
