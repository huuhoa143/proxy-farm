import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortRow } from '../../shared/contracts';
import { defaultSettings } from '../store/state';
import { createStateStore } from '../store/state';
import { createHmaLocalSource } from './hma-local';
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

describe('HMA local source (spec §5.1)', () => {
  const blob = (inner: object) => JSON.stringify({ 'DeviceManager.device': Buffer.from(JSON.stringify(inner)).toString('base64') });

  it('reads udid/password from a tokenCoreSE.json-shaped file', async () => {
    const p = join(dir, 'tokenCoreSE.json');
    writeFileSync(p, blob({ udid: 'U1.test', credentials: { password: 'f'.repeat(64) } }));
    expect(await createHmaLocalSource({ platform: 'darwin', tokenPath: p }).read()).toEqual({
      status: 'found',
      creds: { udid: 'U1.test', password: 'f'.repeat(64) },
    });
  });

  it('reports missing / invalid files, and helper-missing on Windows', async () => {
    expect(await createHmaLocalSource({ platform: 'darwin', tokenPath: join(dir, 'nope.json') }).read()).toEqual({ status: 'missing' });
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{}');
    expect((await createHmaLocalSource({ platform: 'darwin', tokenPath: p }).read()).status).toBe('invalid');
  });

  describe('on Windows', () => {
    const USER = `U1.00000000-0000-4000-8000-000000000000.hma101.${'A'.repeat(64)}`;
    const PASS = 'B'.repeat(64);
    // Every path injected: the real ones would read this machine's HMA install.
    const win = (o: { hma?: string; auth?: string; mirrorDir?: string }) =>
      createHmaLocalSource({
        platform: 'win32',
        winHmaDir: o.hma ?? join(dir, 'no-hma'),
        winAuthPath: o.auth ?? join(dir, 'no-hma', 'auth'),
        winMirrorDir: o.mirrorDir ?? join(dir, 'no-mirror'),
        winMirrorPath: join(o.mirrorDir ?? join(dir, 'no-mirror'), 'auth'),
      });

    it('reads the HMA support copy of the auth file', async () => {
      mkdirSync(join(dir, 'mirror'));
      writeFileSync(join(dir, 'mirror', 'auth'), `${USER}\r\n${PASS}\r\n`);
      expect(await win({ hma: dir, mirrorDir: join(dir, 'mirror') }).read()).toEqual({ status: 'found', creds: { udid: USER, password: PASS } });
    });

    it("reads HMA's own auth file when it is readable (the app runs elevated)", async () => {
      writeFileSync(join(dir, 'auth'), `${USER}\r\n${PASS}\r\n`);
      expect(await win({ hma: dir, auth: join(dir, 'auth') }).read()).toEqual({ status: 'found', creds: { udid: USER, password: PASS } });
    });

    it('reports helper-missing when HMA is installed but HMA support is not enabled', async () => {
      expect(await win({ hma: dir }).read()).toEqual({ status: 'helper-missing' });
    });

    it('reports a signed-out HMA (support on, no copy) as invalid, and an absent HMA as missing', async () => {
      mkdirSync(join(dir, 'empty-mirror'));
      // Support enabled but HMA has no credentials: point the user at HMA, not "not installed".
      expect((await win({ hma: dir, mirrorDir: join(dir, 'empty-mirror') }).read()).status).toBe('invalid');
      expect(await win({}).read()).toEqual({ status: 'missing' });
    });

    it('reports an unreadable copy as invalid', async () => {
      mkdirSync(join(dir, 'bad-mirror'));
      writeFileSync(join(dir, 'bad-mirror', 'auth'), '');
      expect((await win({ hma: dir, mirrorDir: join(dir, 'bad-mirror') }).read()).status).toBe('invalid');
    });
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
