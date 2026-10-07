import { describe, expect, it } from 'vitest';
import { createRefusalTracker, REFUSAL_TTL_MS } from './refusals';

describe('refusal tracker (§5.2 ZoogVPN plan vs login heuristic)', () => {
  it('not-in-plan: auth failure on one server while another on the account is online', () => {
    const t = createRefusalTracker();
    t.recordOnline('z1', 'zoogvpn:nl');
    t.recordAuthFailure('z1', 'zoogvpn:us');
    expect(t.classifyAuthFailure('z1')).toBe('not-in-plan');
    expect(t.isRefused('z1', 'zoogvpn:us')).toBe(true);
    // the online server itself is not refused
    expect(t.isRefused('z1', 'zoogvpn:nl')).toBe(false);
  });

  it('bad-login: failures on >= 3 distinct servers and none online', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    expect(t.classifyAuthFailure('z1')).toBe('undecided');
    t.recordAuthFailure('z1', 'c');
    expect(t.classifyAuthFailure('z1')).toBe('bad-login');
  });

  it('a repeated failure on the same server does not by itself reach the 3-server threshold', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'a');
    expect(t.classifyAuthFailure('z1')).toBe('undecided');
  });

  it('a success on one server resets the bad-login verdict for the account', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    t.recordAuthFailure('z1', 'c');
    expect(t.classifyAuthFailure('z1')).toBe('bad-login');
    t.recordOnline('z1', 'd');
    expect(t.classifyAuthFailure('z1')).toBe('not-in-plan');
  });

  it('expires a refusal after 7 days using the injected clock', () => {
    let now = 1_000_000;
    const t = createRefusalTracker({ clock: () => now });
    t.recordAuthFailure('z1', 'zoogvpn:us');
    expect(t.isRefused('z1', 'zoogvpn:us')).toBe(true);
    now += REFUSAL_TTL_MS - 1;
    expect(t.isRefused('z1', 'zoogvpn:us')).toBe(true);
    now += 2;
    expect(t.isRefused('z1', 'zoogvpn:us')).toBe(false);
  });

  it('expired failures do not count toward the 3-server bad-login threshold', () => {
    let now = 0;
    const t = createRefusalTracker({ clock: () => now });
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    now += REFUSAL_TTL_MS + 1;
    t.recordAuthFailure('z1', 'c');
    // a and b have expired; only c is a live failure
    expect(t.classifyAuthFailure('z1')).toBe('undecided');
  });

  it('accounts are tracked independently', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    t.recordAuthFailure('z1', 'c');
    expect(t.classifyAuthFailure('z1')).toBe('bad-login');
    expect(t.classifyAuthFailure('z2')).toBe('undecided');
    expect(t.isRefused('z2', 'a')).toBe(false);
  });
});
