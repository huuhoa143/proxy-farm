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

  it('shows a location-specific message for an auth failure when the account works elsewhere', () => {
    const state = { kind: 'failed', reason: 'auth', untilMs: Date.now() + 60_000, attempt: 1 } as const;
    const normal = describePortState(state, 'hma', i18next.t.bind(i18next));
    const locationRejected = describePortState(state, 'hma', i18next.t.bind(i18next), { accountHasWorkingPeer: true });

    // Still terminal (no retry), but the copy steers to another location, not "check your login".
    expect(locationRejected.terminal).toBe(true);
    expect(locationRejected.label).not.toBe(normal.label);
    expect(locationRejected.guidance).not.toBe(normal.guidance);
    expect(locationRejected.guidance).toMatch(/location/i);
    // Without a working peer, keep the original "check sign-in" guidance.
    expect(normal.guidance).toMatch(/signed in/i);
  });

  it('failed(key-rejected) is action-needed with no countdown, with Surfshark-specific guidance', () => {
    expect(isTerminalFailure('key-rejected')).toBe(true);
    const state: PortState = { kind: 'failed', reason: 'key-rejected', untilMs: Date.now(), attempt: 3 };
    const t = i18next.t.bind(i18next);
    const ss = describePortState(state, 'surfshark', t);
    expect(ss).toMatchObject({ tone: 'bad', label: 'Key not answered', terminal: true, countdownSeconds: undefined });
    expect(ss.guidance).toMatch(/^Surfshark didn't answer this key on 3 servers\..*Manual setup → WireGuard.*suspended/);
    expect(describePortState(state, 'file', t).guidance).toMatch(/WireGuard key/);
  });

  it('a rate-limited retry explains the wait', () => {
    const state: PortState = { kind: 'retrying', untilMs: Date.now() + 5_000, attempt: 1, reasonKey: 'rate-limited' };
    expect(describePortState(state, 'surfshark', i18next.t.bind(i18next)).guidance).toMatch(/too often/);
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

  describe('what the login check found (spec §5.2)', () => {
    const t = () => i18next.t.bind(i18next);
    const failed = (reason: 'auth' | 'not-in-plan', detail?: 'wrong-credentials' | 'unverified-login' | 'location-not-in-plan'): PortState => ({
      kind: 'failed',
      reason,
      untilMs: Date.now(),
      attempt: 1,
      ...(detail ? { detail } : {}),
    });

    it('wrong-credentials says the email or password is wrong, and that it is not the plan', () => {
      const view = describePortState(failed('auth', 'wrong-credentials'), 'zoogvpn', t());
      expect(view.label).toBe('Wrong email or password');
      expect(view.guidance).toContain('ZoogVPN refused this email and password, on a free server too');
      expect(view.terminal).toBe(true);
      // Another port of the account online does not turn it into a "location" message.
      expect(describePortState(failed('auth', 'wrong-credentials'), 'zoogvpn', t(), { accountHasWorkingPeer: true }).label).toBe('Wrong email or password');
    });

    it('unverified-login never claims the password is wrong', () => {
      const view = describePortState(failed('auth', 'unverified-login'), 'zoogvpn', t());
      expect(view.label).toBe("Sign-in couldn't be verified");
      expect(view.guidance).not.toMatch(/is wrong/);
    });

    it('a whole location outside the plan: pick another location or upgrade (en + vi)', () => {
      const view = describePortState(failed('not-in-plan', 'location-not-in-plan'), 'zoogvpn', t());
      expect(view.label).toBe('Not in your plan');
      expect(view.guidance).toBe("Your ZoogVPN plan doesn't include this location — pick another location or upgrade your plan.");
      void i18next.changeLanguage('vi');
      try {
        expect(describePortState(failed('not-in-plan', 'location-not-in-plan'), 'zoogvpn', t()).guidance).toBe(
          'Gói ZoogVPN của bạn không bao gồm vị trí này — chọn vị trí khác hoặc nâng cấp gói.',
        );
      } finally {
        void i18next.changeLanguage('en');
      }
    });

    it('a plan refusal of one server, and the live check in progress, name the provider', () => {
      const moving: PortState = { kind: 'retrying', untilMs: Date.now() + 1000, attempt: 1, reasonKey: 'server-not-in-plan' };
      expect(describePortState(moving, 'zoogvpn', t()).guidance).toBe("Your ZoogVPN plan doesn't include this server — moving to another one.");
      const checking: PortState = { kind: 'retrying', untilMs: Date.now() + 1000, attempt: 1, reasonKey: 'checking-sign-in' };
      expect(describePortState(checking, 'zoogvpn', t()).guidance).toContain('on a ZoogVPN free server');
    });
  });
});
