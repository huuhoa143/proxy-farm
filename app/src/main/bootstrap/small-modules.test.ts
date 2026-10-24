import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortRow } from '../../shared/contracts';
import { defaultSettings } from '../store/state';
import { createStateStore } from '../store/state';
import { resolveMainLanguage, mainStrings } from './main-strings';
import { observeStateStore } from './observed-state';
import { createSessionSecretStore } from './session-secrets';
import { settingsEffects } from './settings-effects';
import { isTranslocatedOrOnDmg } from './translocation';
import { trayIconBitmap } from './tray-icon';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-boot-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fakeSafe = (available: boolean) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
});

describe('session secret store', () => {
  it('encrypts to disk when safeStorage is available', () => {
    const store = createSessionSecretStore(fakeSafe(true), join(dir, 's'));
    store.saveSecret('a', 'pw');
    expect(store.unavailable).toBe(false);
    expect(readdirSync(join(dir, 's'))).toHaveLength(1);
    expect(store.loadSecret('a')).toBe('pw');
  });

  it('keeps secrets in memory only (never plaintext on disk) when safeStorage is unavailable', () => {
    const store = createSessionSecretStore(fakeSafe(false), join(dir, 's'));
    store.saveSecret('a', 'pw');
    expect(store.unavailable).toBe(true);
    expect(existsSync(join(dir, 's'))).toBe(false);
    expect(store.loadSecret('a')).toBe('pw');
    store.deleteSecret('a');
    expect(store.loadSecret('a')).toBeNull();
  });

  it('lets the state store run on top of it without throwing', () => {
    const secrets = createSessionSecretStore(fakeSafe(false), join(dir, 's'));
    const state = createStateStore(join(dir, 'state.json'), secrets);
    const pass = state.getState().settings.proxyPass;
    expect(pass).toBeTruthy();
    expect(secrets.loadSecret('settings:proxyPass')).toBe(pass);
  });
});

describe('settingsEffects', () => {
  const base = defaultSettings(() => 'pw');
  it('restarts ports on LAN / proxy credential changes only', () => {
    expect(settingsEffects(base, { ...base, lanSharing: true }).restartPorts).toBe(true);
    expect(settingsEffects(base, { ...base, proxyPass: 'x' }).restartPorts).toBe(true);
    expect(settingsEffects(base, { ...base, basePort: 1 }).restartPorts).toBe(false);
  });
  it('restarts the webhook on webhook or LAN changes', () => {
    expect(settingsEffects(base, { ...base, webhook: { ...base.webhook, enabled: true } }).restartWebhook).toBe(true);
    expect(settingsEffects(base, { ...base, lanSharing: true }).restartWebhook).toBe(true);
    expect(settingsEffects(base, { ...base, keepAwake: false })).toMatchObject({ restartWebhook: false, refreshKeepAwake: true });
  });
});

describe('isTranslocatedOrOnDmg (spec §9)', () => {
  it('flags translocated and DMG-mounted paths only', () => {
    expect(isTranslocatedOrOnDmg('/private/var/folders/x/T/AppTranslocation/ABC/d/Proxy Farm.app/Contents/MacOS/Proxy Farm')).toBe(true);
    expect(isTranslocatedOrOnDmg('/Volumes/Proxy Farm/Proxy Farm.app/Contents/MacOS/Proxy Farm')).toBe(true);
    expect(isTranslocatedOrOnDmg('/Applications/Proxy Farm.app/Contents/MacOS/Proxy Farm')).toBe(false);
  });
});

describe('observeStateStore', () => {
  it('coalesces several port writes into one notification and ignores non-port writes', () => {
    const inner = createStateStore(join(dir, 'state.json'), { saveSecret: () => undefined, loadSecret: () => null, deleteSecret: () => undefined });
    const deferred: Array<() => void> = [];
    const seen: PortRow[][] = [];
    const store = observeStateStore(inner, (rows) => seen.push(rows), (cb) => deferred.push(cb));
    const row = { key: 'k', providerId: 'hma', accountId: 'a', label: 'l', country: 'NL', city: 'c', proxyPort: 1, enabled: true, state: { kind: 'queued' }, autoRotateMin: 0 } as PortRow;
    store.setState((s) => ({ ...s, ports: [row] }));
    store.setState((s) => ({ ...s, ports: [{ ...row, enabled: false }] }));
    store.setState((s) => ({ ...s, limits: { ...s.limits, hma: 2 } }));
    expect(deferred).toHaveLength(1);
    deferred[0]();
    expect(seen).toHaveLength(1);
    expect(seen[0][0].enabled).toBe(false);
  });
});

describe('main-process strings', () => {
  it('resolves system language from the OS locale (Vietnamese unless explicitly English) and reads the app.* keys', () => {
    expect(resolveMainLanguage('system', 'vi-VN')).toBe('vi');
    expect(resolveMainLanguage('system', 'en-US')).toBe('en');
    expect(resolveMainLanguage('system', 'fr-FR')).toBe('vi');
    expect(resolveMainLanguage('en', 'vi')).toBe('en');
    expect(resolveMainLanguage('vi', 'en-US')).toBe('vi');
    expect(mainStrings('vi').moveNow).not.toBe(mainStrings('en').moveNow);
  });
});

describe('tray icon bitmap', () => {
  it('is a BGRA square with transparent corners and an opaque centre dot', () => {
    const size = 32;
    const buf = trayIconBitmap(size);
    expect(buf.length).toBe(size * size * 4);
    expect(buf[3]).toBe(0); // top-left alpha
    const centre = (16 * size + 16) * 4;
    expect(buf[centre + 3]).toBeGreaterThan(200);
  });
});
