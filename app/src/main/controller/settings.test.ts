import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/contracts';
import { MIN_BEARER_LENGTH } from '../webhook/index';
import { applySettingsPatch } from './settings';

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    proxyUser: 'proxy',
    proxyPass: 'secretpw',
    basePort: 29001,
    lanSharing: false,
    keepAwake: true,
    launchAtLogin: false,
    giveUpAfter: 0,
    webhook: { enabled: false, port: 0, bearer: '' },
    language: 'system',
    autoCheckUpdates: true,
    acknowledgedDisclaimer: 0,
    ...overrides,
  };
}

describe('applySettingsPatch (reviewer critical item 1: LAN sharing must never be an open proxy)', () => {
  it('rejects enabling lanSharing with no proxyUser/proxyPass set', () => {
    const current = baseSettings({ proxyUser: '', proxyPass: '' });
    const result = applySettingsPatch(current, { lanSharing: true });
    expect(result).toEqual({ ok: false, reasonKey: 'settings.lanSharingRequiresAuth' });
  });

  it('rejects clearing proxyUser/proxyPass while lanSharing is already on', () => {
    const current = baseSettings({ lanSharing: true });
    const result = applySettingsPatch(current, { proxyPass: '' });
    expect(result).toEqual({ ok: false, reasonKey: 'settings.lanSharingRequiresAuth' });
  });

  it('allows enabling lanSharing when proxyUser/proxyPass are already set', () => {
    const current = baseSettings();
    const result = applySettingsPatch(current, { lanSharing: true });
    expect(result.ok).toBe(true);
    expect((result as any).settings.lanSharing).toBe(true);
  });

  it('allows disabling lanSharing regardless of credentials', () => {
    const current = baseSettings({ lanSharing: true });
    const result = applySettingsPatch(current, { lanSharing: false, proxyUser: '', proxyPass: '' });
    expect(result.ok).toBe(true);
  });
});

describe('applySettingsPatch (webhook bearer minors)', () => {
  it('auto-generates a strong bearer when the webhook is enabled with an empty one', () => {
    const current = baseSettings();
    const result = applySettingsPatch(current, { webhook: { enabled: true, port: 9000, bearer: '' } });
    expect(result.ok).toBe(true);
    const bearer = (result as any).settings.webhook.bearer as string;
    expect(bearer.length).toBeGreaterThanOrEqual(MIN_BEARER_LENGTH);
  });

  it('rejects a bearer shorter than the minimum length', () => {
    const current = baseSettings();
    const result = applySettingsPatch(current, { webhook: { enabled: true, port: 9000, bearer: 'short' } });
    expect(result).toEqual({ ok: false, reasonKey: 'settings.webhookBearerTooShort' });
  });

  it('keeps an already-strong bearer unchanged', () => {
    const current = baseSettings();
    const strong = 'a'.repeat(MIN_BEARER_LENGTH);
    const result = applySettingsPatch(current, { webhook: { enabled: true, port: 9000, bearer: strong } });
    expect(result.ok).toBe(true);
    expect((result as any).settings.webhook.bearer).toBe(strong);
  });

  it('does not require a bearer when the webhook is disabled', () => {
    const current = baseSettings();
    const result = applySettingsPatch(current, { webhook: { enabled: false, port: 0, bearer: '' } });
    expect(result.ok).toBe(true);
  });

  it('merges a partial webhook patch onto the current webhook settings', () => {
    const current = baseSettings({ webhook: { enabled: true, port: 9000, bearer: 'a'.repeat(20) } });
    const result = applySettingsPatch(current, { webhook: { port: 9100 } as any });
    expect(result.ok).toBe(true);
    expect((result as any).settings.webhook).toEqual({ enabled: true, port: 9100, bearer: 'a'.repeat(20) });
  });
});
