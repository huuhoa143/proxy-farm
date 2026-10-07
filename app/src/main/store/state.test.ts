import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateStore, defaultSettings, SCHEMA_VERSION } from './state';

describe('state store', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-state-'));
    filePath = join(dir, 'state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates defaults on first read and persists them to disk', () => {
    const store = createStateStore(filePath);
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

  it('generates a different random proxyPass per fresh store unless overridden', () => {
    const passes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const d = mkdtempSync(join(tmpdir(), 'pf-state-pass-'));
      const s = createStateStore(join(d, 'state.json'));
      passes.add(s.getState().settings.proxyPass);
      rmSync(d, { recursive: true, force: true });
    }
    expect(passes.size).toBe(3);
  });

  it('setState writes atomically: readable afterwards and no temp file left behind', () => {
    const store = createStateStore(filePath);
    store.getState();
    const next = store.setState((s) => ({ ...s, limits: { ...s.limits, hma: 5 } as any }));
    expect(next.limits.hma).toBe(5);

    const files = readdirSync(dir);
    expect(files).toEqual(['state.json']);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);

    // a fresh store instance reads back the persisted value from disk
    const reopened = createStateStore(filePath);
    expect(reopened.getState().limits.hma).toBe(5);
  });

  it('setState sees the result of the previous setState (read-modify-write)', () => {
    const store = createStateStore(filePath);
    store.setState((s) => ({ ...s, ports: [...s.ports, { key: 'a' } as any] }));
    store.setState((s) => ({ ...s, ports: [...s.ports, { key: 'b' } as any] }));
    expect(store.getState().ports.map((p: any) => p.key)).toEqual(['a', 'b']);
  });

  it('accepts an injectable random password generator', () => {
    const store = createStateStore(filePath, { randomPass: () => 'fixed-pass' });
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
});
