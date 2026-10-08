import { describe, expect, it, beforeAll } from 'vitest';
import i18next from 'i18next';
import { initI18n } from './i18n';
import { describePortState, isTerminalFailure } from './portStateView';
import type { PortState } from '../shared/contracts';

beforeAll(() => {
  initI18n('en');
});

describe('describePortState', () => {
  it('renders queued/connecting/verifying/online/stopped with the right label and neutral-or-progress tone', () => {
    const cases: Array<[PortState, string]> = [
      [{ kind: 'queued' }, 'Queued'],
      [{ kind: 'connecting', since: Date.now() }, 'Connecting…'],
      [{ kind: 'verifying', since: Date.now() }, 'Verifying…'],
      [{ kind: 'online', since: Date.now(), exitIp: '1.2.3.4', country: 'JP' }, 'Online'],
      [{ kind: 'stopped' }, 'Stopped'],
    ];
    for (const [state, label] of cases) {
      const view = describePortState(state, 'hma', i18next.t.bind(i18next));
      expect(view.label).toBe(label);
    }
  });

  it('translates bare engine retry reasons (integration)', () => {
    const state: PortState = { kind: 'retrying', untilMs: Date.now() + 5_000, attempt: 2, reasonKey: 'unreachable' };
    expect(describePortState(state, 'hma', i18next.t.bind(i18next)).guidance).toBe("The server isn't answering.");
  });

  it('renders a retrying countdown with a guidance reason', () => {
    const state: PortState = { kind: 'retrying', untilMs: Date.now() + 10_000, attempt: 1, reasonKey: 'portState.failed.no-server.guidance' };
    const view = describePortState(state, 'surfshark', i18next.t.bind(i18next));
    expect(view.tone).toBe('warn');
    expect(view.label).toMatch(/Retrying in \d+s/);
    expect(view.countdownSeconds).toBeGreaterThanOrEqual(9);
  });

  it('gives HMA-specific guidance for failed(auth) matching the spec wording', () => {
    const state: PortState = { kind: 'failed', reason: 'auth', untilMs: Date.now() + 1000, attempt: 3 };
    const view = describePortState(state, 'hma', i18next.t.bind(i18next));
    expect(view.tone).toBe('bad');
    expect(view.guidance).toBe(
      "HMA rejected the device credentials — open the HMA app and check you're signed in.",
    );
  });

  it('gives ZoogVPN-specific guidance for failed(auth), distinct from HMA', () => {
    const state: PortState = { kind: 'failed', reason: 'auth', untilMs: Date.now() + 1000, attempt: 3 };
    const view = describePortState(state, 'zoogvpn', i18next.t.bind(i18next));
    expect(view.guidance).toContain('ZoogVPN');
  });

  it('surfaces an action label for failed(port-in-use)', () => {
    const state: PortState = { kind: 'failed', reason: 'port-in-use', untilMs: Date.now() + 1000, attempt: 1 };
    const view = describePortState(state, 'surfshark', i18next.t.bind(i18next));
    expect(view.actionLabel).toBe('Move to another port');
  });

  it('marks auth/not-in-plan as terminal (no countdown) and port-in-use/no-server as transient', () => {
    expect(isTerminalFailure('auth')).toBe(true);
    expect(isTerminalFailure('not-in-plan')).toBe(true);
    expect(isTerminalFailure('port-in-use')).toBe(false);
    expect(isTerminalFailure('no-server')).toBe(false);

    const auth = describePortState(
      { kind: 'failed', reason: 'auth', untilMs: Date.now() + 60_000, attempt: 3 },
      'hma',
      i18next.t.bind(i18next),
    );
    expect(auth.terminal).toBe(true);
    expect(auth.countdownSeconds).toBeUndefined();

    const noServer = describePortState(
      { kind: 'failed', reason: 'no-server', untilMs: Date.now() + 60_000, attempt: 3 },
      'hma',
      i18next.t.bind(i18next),
    );
    expect(noServer.terminal).toBe(false);
    expect(noServer.countdownSeconds).toBeGreaterThan(0);
  });

  it('covers failed(not-in-plan) and failed(no-server) with distinct labels', () => {
    const notInPlan = describePortState(
      { kind: 'failed', reason: 'not-in-plan', untilMs: Date.now(), attempt: 1 },
      'zoogvpn',
      i18next.t.bind(i18next),
    );
    const noServer = describePortState(
      { kind: 'failed', reason: 'no-server', untilMs: Date.now(), attempt: 1 },
      'surfshark',
      i18next.t.bind(i18next),
    );
    expect(notInPlan.label).not.toBe(noServer.label);
  });
});
