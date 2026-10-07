import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretStore, type SafeStorageLike } from './secrets';
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
    expect(state.settings.language).toBe('system');
    expect(existsSync(filePath)).toBe(true);
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
      language: 'system',
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

    it('a file missing schemaVersion entirely is treated the same way', () => {
      writeFileSync(filePath, JSON.stringify({ ports: [] }));
      const store = createStateStore(filePath, secrets());
      expect(store.getState().schemaVersion).toBe(SCHEMA_VERSION);
      expect(readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    });
  });

  describe('fills missing fields with defaults (forward/backward compatibility)', () => {
    it('a partial file (old/hand-edited) gets missing top-level fields filled in', () => {
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, ports: [{ key: 'kept' } as any] }));
      const store = createStateStore(filePath, secrets());
      const state = store.getState();
      expect(state.ports).toEqual([{ key: 'kept' }]);
      expect(state.accounts).toEqual([]);
      expect(state.limits).toEqual({});
      expect(state.refusals).toEqual({ failures: {}, online: {} });
      expect(state.portServers).toEqual({});
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
});
