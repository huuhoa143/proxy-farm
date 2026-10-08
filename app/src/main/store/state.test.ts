import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretStore, type SafeStorageLike, type SecretStore } from './secrets';
import { createStateStore, defaultSettings, PROXY_PASS_SECRET_ID, SCHEMA_VERSION, WEBHOOK_BEARER_SECRET_ID } from './state';

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
  };
}

describe('state store', () => {
  let dir: string;
  let filePath: string;
  let secretsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-state-'));
    filePath = join(dir, 'state.json');
    secretsDir = mkdtempSync(join(tmpdir(), 'pf-state-secrets-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  });

  function secrets() {
    return createSecretStore(fakeSafeStorage(), secretsDir);
  }

  it('creates defaults on first read and persists them to disk', () => {
    const store = createStateStore(filePath, secrets());
    const state = store.getState();
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.ports).toEqual([]);
    expect(state.settings.basePort).toBe(29001);
    expect(state.settings.lanSharing).toBe(false);
    expect(state.settings.keepAwake).toBe(true);
    expect(state.settings.giveUpAfter).toBe(0);
    expect(state.settings.webhook).toEqual({ enabled: false, port: 0, bearer: '' });
    expect(state.settings.proxyUser).toBe('proxy');
    expect(state.settings.proxyPass).toBeTruthy();
    expect(state.settings.language).toBe('vi');
    expect(existsSync(filePath)).toBe(true);
  });

  it('a file from before the first-run disclaimer loads as not acknowledged, and an acknowledgement persists', () => {
    writeFileSync(filePath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings: { basePort: 30001 } }));
    const store = createStateStore(filePath, secrets());
    expect(store.getState().settings.acknowledgedDisclaimer).toBe(0);
    store.setState((s) => ({ ...s, settings: { ...s.settings, acknowledgedDisclaimer: 1 } }));
    expect(createStateStore(filePath, secrets()).getState().settings.acknowledgedDisclaimer).toBe(1);
  });

  it('keeps a language the user already picked, and defaults a file without one to Vietnamese', () => {
    writeFileSync(filePath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings: { language: 'en' } }));
    expect(createStateStore(filePath, secrets()).getState().settings.language).toBe('en');
    writeFileSync(filePath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings: { basePort: 30001 } }));
    expect(createStateStore(filePath, secrets()).getState().settings.language).toBe('vi');
  });

  it('never writes proxyPass or webhook.bearer in plaintext to state.json', () => {
    const store = createStateStore(filePath, secrets(), { randomPass: () => 'super-secret-pass' });
    store.setState((s) => ({ ...s, settings: { ...s.settings, webhook: { ...s.settings.webhook, bearer: 'my-bearer-token' } } }));
    const onDisk = readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain('super-secret-pass');
    expect(onDisk).not.toContain('my-bearer-token');
    // but the in-memory state still has the real plaintext values
    expect(store.getState().settings.proxyPass).toBe('super-secret-pass');
    expect(store.getState().settings.webhook.bearer).toBe('my-bearer-token');
  });

  it('resolves proxyPass/bearer back from the secret store when reopened fresh', () => {
    const secretsForBoth = secrets();
    const store = createStateStore(filePath, secretsForBoth, { randomPass: () => 'super-secret-pass' });
    store.setState((s) => ({ ...s, settings: { ...s.settings, webhook: { ...s.settings.webhook, bearer: 'my-bearer-token' } } }));

    const reopened = createStateStore(filePath, secretsForBoth);
    expect(reopened.getState().settings.proxyPass).toBe('super-secret-pass');
    expect(reopened.getState().settings.webhook.bearer).toBe('my-bearer-token');
  });

  it('secret ids are the documented well-known constants', () => {
    expect(PROXY_PASS_SECRET_ID).toBe('settings:proxyPass');
    expect(WEBHOOK_BEARER_SECRET_ID).toBe('settings:webhook:bearer');
  });

  it('generates a different random proxyPass per fresh store unless overridden', () => {
    const passes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      // A fresh secrets dir per iteration too: two genuinely separate installs, each
      // with their own secret store, not one install's secrets bleeding into the next.
      const d = mkdtempSync(join(tmpdir(), 'pf-state-pass-'));
      const sd = mkdtempSync(join(tmpdir(), 'pf-state-pass-secrets-'));
      const s = createStateStore(join(d, 'state.json'), createSecretStore(fakeSafeStorage(), sd));
      passes.add(s.getState().settings.proxyPass);
      rmSync(d, { recursive: true, force: true });
      rmSync(sd, { recursive: true, force: true });
    }
    expect(passes.size).toBe(3);
  });

  it('setState writes atomically: readable afterwards and no temp file left behind', () => {
    const store = createStateStore(filePath, secrets());
    store.getState();
    const next = store.setState((s) => ({ ...s, limits: { ...s.limits, hma: 5 } as any }));
    expect(next.limits.hma).toBe(5);

    const files = readdirSync(dir);
    expect(files).toEqual(['state.json']);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);

    const reopened = createStateStore(filePath, secrets());
    expect(reopened.getState().limits.hma).toBe(5);
  });

  it('setState sees the result of the previous setState (read-modify-write)', () => {
    const store = createStateStore(filePath, secrets());
    store.setState((s) => ({ ...s, ports: [...s.ports, { key: 'a' } as any] }));
    store.setState((s) => ({ ...s, ports: [...s.ports, { key: 'b' } as any] }));
    expect(store.getState().ports.map((p: any) => p.key)).toEqual(['a', 'b']);
  });

  it('accepts an injectable random password generator', () => {
    const store = createStateStore(filePath, secrets(), { randomPass: () => 'fixed-pass' });
    expect(store.getState().settings.proxyPass).toBe('fixed-pass');
  });

  it('defaultSettings() alone matches the spec defaults', () => {
    const s = defaultSettings(() => 'x');
    expect(s).toMatchObject({
      proxyUser: 'proxy',
      proxyPass: 'x',
      basePort: 29001,
      lanSharing: false,
      keepAwake: true,
      launchAtLogin: false,
      giveUpAfter: 0,
      webhook: { enabled: false, port: 0, bearer: '' },
      language: 'vi',
      acknowledgedDisclaimer: 0,
    });
  });

  describe('corruption recovery (reviewer item 12)', () => {
    it('a file that fails to parse as JSON is backed up, and defaults are used instead', () => {
      writeFileSync(filePath, 'this is not json {{{');
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.ports).toEqual([]);
      const files = readdirSync(dir);
      expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
      const backup = files.find((f) => f.startsWith('state.json.corrupt-'))!;
      expect(readFileSync(join(dir, backup), 'utf8')).toBe('this is not json {{{');
    });

    it('a file with an unknown schemaVersion is backed up, and defaults are used instead', () => {
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, ports: [{ key: 'should-not-survive' }] }));
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.ports).toEqual([]);
      expect(readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    });

    it('a file missing schemaVersion entirely is migrated (treated as v0), not corrupt (reviewer item 10)', () => {
      writeFileSync(filePath, JSON.stringify({ ports: [{ key: 'kept' }] }));
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      // Migrated via fillDefaults, not discarded: the field that WAS present survives.
      expect(state.ports).toEqual([{ key: 'kept#1', locationKey: 'kept' }]);
      expect(readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(false);
    });
  });

  describe('secrets never fall back to the on-disk placeholder (reviewer item 4 — SECURITY)', () => {
    it('a loaded file whose proxy-password secret cannot be found gets a fresh random password, never the literal placeholder', () => {
      // Simulate state.json already written with the real secrets saved elsewhere, then
      // the secret store losing/never having the proxyPass entry (e.g. a different
      // profile dir, or a corrupted secrets file).
      const s = secrets();
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          ports: [],
          accounts: [],
          limits: {},
          refusals: { failures: {}, online: {} },
          serverHealth: { refused: {}, lastOk: {} },
          settings: { ...defaultSettings(() => '<secret>'), webhook: { enabled: false, port: 0, bearer: '<secret>' } },
        }),
      );
      const store = createStateStore(filePath, s, { randomPass: () => 'freshly-generated-pass' });
      const state = store.getState();
      expect(state.settings.proxyPass).toBe('freshly-generated-pass');
      expect(state.settings.proxyPass).not.toBe('<secret>');
      expect(state.settings.webhook.bearer).not.toBe('<secret>');
      expect(store.takeSecretNotice()).toMatch(/proxy password/i);
    });

    it('a loaded file whose webhook bearer secret cannot be found disables the webhook instead of using the placeholder', () => {
      const s = secrets();
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          ports: [],
          accounts: [],
          limits: {},
          refusals: { failures: {}, online: {} },
          serverHealth: { refused: {}, lastOk: {} },
          settings: { ...defaultSettings(() => 'pass'), webhook: { enabled: true, port: 9000, bearer: '<secret>' } },
        }),
      );
      const store = createStateStore(filePath, s);
      const state = store.getState();
      expect(state.settings.webhook.bearer).toBe('');
      expect(state.settings.webhook.enabled).toBe(false);
      expect(store.takeSecretNotice()).toMatch(/webhook/i);
    });

    it('takeSecretNotice is one-time: a second call returns null', () => {
      const s = secrets();
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          ports: [],
          accounts: [],
          limits: {},
          refusals: { failures: {}, online: {} },
          serverHealth: { refused: {}, lastOk: {} },
          settings: { ...defaultSettings(() => 'pass'), webhook: { enabled: false, port: 0, bearer: '<secret>' } },
        }),
      );
      const store = createStateStore(filePath, s);
      store.getState();
      expect(store.takeSecretNotice()).not.toBeNull();
      expect(store.takeSecretNotice()).toBeNull();
    });

    it('a fresh install is unaffected: no secret saved yet is the expected first-run case, not an error', () => {
      const store = createStateStore(filePath, secrets(), { randomPass: () => 'first-run-pass' });
      const state = store.getState();
      expect(state.settings.proxyPass).toBe('first-run-pass');
      expect(store.takeSecretNotice()).toBeNull();
      expect(store.secretsUnavailable()).toBe(false);
    });
  });

  describe('secretsUnavailable() and degraded persistence (reviewer item 4)', () => {
    function brokenSecrets(): SecretStore {
      return {
        saveSecret: () => {
          throw new Error('safeStorage encryption is not available on this platform');
        },
        loadSecret: () => null,
        deleteSecret: () => undefined,
      };
    }

    it('setState does not throw when the secret store cannot save, and non-secret state still persists', () => {
      const store = createStateStore(filePath, brokenSecrets(), { randomPass: () => 'in-memory-pass' });
      expect(() => store.setState((s) => ({ ...s, limits: { ...s.limits, hma: 7 } as any }))).not.toThrow();
      expect(store.getState().limits.hma).toBe(7);
      expect(store.getState().settings.proxyPass).toBe('in-memory-pass');
      expect(store.secretsUnavailable()).toBe(true);
      // state.json itself was still written (non-secret fields persist normally).
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('secret files are only rewritten when the value actually changes (reviewer minor)', () => {
    it('does not re-save proxyPass/bearer on a setState that leaves them untouched', () => {
      const saveCalls: string[] = [];
      const base = secrets();
      const spying: SecretStore = {
        saveSecret: (id, v) => {
          saveCalls.push(id);
          base.saveSecret(id, v);
        },
        loadSecret: (id) => base.loadSecret(id),
        deleteSecret: (id) => base.deleteSecret(id),
      };
      const store = createStateStore(filePath, spying);
      store.getState(); // initial creation: one save per secret expected
      const afterInit = saveCalls.length;
      expect(afterInit).toBeGreaterThan(0);

      store.setState((s) => ({ ...s, limits: { ...s.limits, hma: 3 } as any }));
      expect(saveCalls.length).toBe(afterInit); // unchanged proxyPass/bearer -> no new saves

      store.setState((s) => ({ ...s, settings: { ...s.settings, webhook: { ...s.settings.webhook, bearer: 'new-bearer-value' } } }));
      expect(saveCalls.length).toBe(afterInit + 1); // only the bearer actually changed
    });
  });

  describe('fills missing fields with defaults (forward/backward compatibility)', () => {
    it('a partial file (old/hand-edited) gets missing top-level fields filled in', () => {
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, ports: [{ key: 'kept' } as any] }));
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.ports).toEqual([{ key: 'kept#1', locationKey: 'kept' }]);
      expect(state.accounts).toEqual([]);
      expect(state.limits).toEqual({});
      expect(state.refusals).toEqual({ failures: {}, online: {} });
      expect(state.serverHealth).toEqual({ refused: {}, lastOk: {} });
      expect(state.settings.basePort).toBe(29001);
    });

    it('a partial settings object gets missing settings fields filled in', () => {
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, settings: { basePort: 40000 } }));
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.settings.basePort).toBe(40000);
      expect(state.settings.lanSharing).toBe(false);
      expect(state.settings.webhook).toEqual({ enabled: false, port: 0, bearer: '' });
    });
  });

  describe('v1 → v2 migration (spec §6.8)', () => {
    const v1Row = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      providerId: 'hma',
      accountId: 'hma-1',
      label: key,
      country: 'VN',
      city: 'Hanoi',
      proxyPort: 29001,
      enabled: true,
      state: { kind: 'stopped' },
      autoRotateMin: 0,
      ...extra,
    });

    it('turns every row K into K#1 with locationKey K, pins portServers[K] and keeps auto-rotate', () => {
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          ports: [v1Row('hma:VN-51-HANOI', { autoRotateMin: 15 }), v1Row('hma:JP-40-TOKYO', { proxyPort: 29002 })],
          portServers: { 'hma:VN-51-HANOI': '156.59.140.19' },
        }),
      );
      const state = createStateStore(filePath, secrets()).getState();
      expect(state.schemaVersion).toBe(2);
      expect(state.ports.map((p) => [p.key, p.locationKey, p.server, p.autoRotateMin, p.proxyPort])).toEqual([
        ['hma:VN-51-HANOI#1', 'hma:VN-51-HANOI', '156.59.140.19', 15, 29001],
        ['hma:JP-40-TOKYO#1', 'hma:JP-40-TOKYO', undefined, 0, 29002],
      ]);
      expect(state).not.toHaveProperty('portServers');
      // The migrated file is written back as v2, so the next load does not migrate twice.
      const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(onDisk.schemaVersion).toBe(2);
      expect(createStateStore(filePath, secrets()).getState().ports[0].key).toBe('hma:VN-51-HANOI#1');
    });

    it('re-keys refusal evidence from target keys to the servers those targets ran on', () => {
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          ports: [v1Row('zoogvpn:JP-JP3')],
          portServers: { 'zoogvpn:JP-JP3': 'jp3.webunlim.com' },
          refusals: { failures: { z1: { 'zoogvpn:JP-JP3': 5, 'zoogvpn:unknown': 6 } }, online: {} },
        }),
      );
      const state = createStateStore(filePath, secrets()).getState();
      expect(state.refusals.failures).toEqual({ z1: { 'jp3.webunlim.com': 5 } });
    });

    it('keeps the original v1 file as state.json.v1.bak before the first v2 write, and only once', () => {
      const original = JSON.stringify({ schemaVersion: 1, ports: [v1Row('hma:VN-51-HANOI')] });
      writeFileSync(filePath, original);
      createStateStore(filePath, secrets()).getState();
      expect(readFileSync(`${filePath}.v1.bak`, 'utf8')).toBe(original);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).schemaVersion).toBe(2);

      // A later v1 file (say, after running an older build again) never overwrites it.
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, ports: [] }));
      createStateStore(filePath, secrets()).getState();
      expect(readFileSync(`${filePath}.v1.bak`, 'utf8')).toBe(original);
    });

    it('a v2 file is not backed up', () => {
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, ports: [] }));
      createStateStore(filePath, secrets()).getState();
      expect(existsSync(`${filePath}.v1.bak`)).toBe(false);
    });

    it('a v1 file whose migration throws starts over without crashing, but keeps its accounts and settings', () => {
      const accounts = [{ id: 'hma-1', providerId: 'hma', label: 'device', meta: {}, secretRef: 'account:hma-1' }];
      const original = JSON.stringify({
        schemaVersion: 1,
        ports: [null, v1Row('hma:VN-51-HANOI')], // a malformed row makes the migration throw
        accounts,
        settings: { basePort: 30001 },
        limits: { hma: 4 },
      });
      writeFileSync(filePath, original);
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.schemaVersion).toBe(2);
      expect(state.accounts).toEqual(accounts);
      expect(state.settings.basePort).toBe(30001);
      expect(state.limits).toEqual({ hma: 4 });
      expect(state.ports).toEqual([]);
      expect(readFileSync(`${filePath}.v1.bak`, 'utf8')).toBe(original); // nothing lost for good
      expect(store.takeSecretNotice()).toContain('state.json.v1.bak');
    });

    it('persists the webhook location-alias map, defaulting to empty', () => {
      const store = createStateStore(filePath, secrets());
      expect(store.getState().locationAliases).toEqual({});
      store.setState((s) => ({ ...s, locationAliases: { 'zoogvpn:JP-JP3': 'zoogvpn:JP' } }));
      expect(createStateStore(filePath, secrets()).getState().locationAliases).toEqual({ 'zoogvpn:JP-JP3': 'zoogvpn:JP' });
    });

    it('loads a v2 file as is (no second migration)', () => {
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 2,
          ports: [v1Row('hma:VN#2', { locationKey: 'hma:VN' })],
          serverHealth: { refused: { 'hma-1': { '1.2.3.4': 99 } }, lastOk: {} },
        }),
      );
      const state = createStateStore(filePath, secrets()).getState();
      expect(state.ports[0].key).toBe('hma:VN#2');
      expect(state.serverHealth.refused).toEqual({ 'hma-1': { '1.2.3.4': 99 } });
    });
  });
});
