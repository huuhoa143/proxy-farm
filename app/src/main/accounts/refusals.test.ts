import { describe, expect, it } from 'vitest';
import { createRefusalTracker, ONLINE_TTL_MS, REFUSAL_TTL_MS } from './refusals';

describe('refusal tracker (§5.2 last resort when no free-tier server can be reached)', () => {
  it('an auth failure while another server of the account is online is no suspicion; the pair is remembered', () => {
    const t = createRefusalTracker();
    t.recordOnline('z1', 'zoogvpn:nl');
    t.recordAuthFailure('z1', 'zoogvpn:us');
    expect(t.suspectsBadLogin('z1')).toBe(false);
    expect(t.isRefused('z1', 'zoogvpn:us')).toBe(true);
    // the online server itself is not refused
    expect(t.isRefused('z1', 'zoogvpn:nl')).toBe(false);
  });

  it('forgetFailures drops the auth-failure evidence of one account (new credentials)', () => {
    const t = createRefusalTracker();
    for (const s of ['a', 'b', 'c']) t.recordAuthFailure('z1', s);
    t.recordAuthFailure('z2', 'a');
    expect(t.suspectsBadLogin('z1')).toBe(true);
    t.forgetFailures('z1');
    expect(t.suspectsBadLogin('z1')).toBe(false);
    expect(t.isRefused('z1', 'a')).toBe(false);
    expect(t.isRefused('z2', 'a')).toBe(true);
  });

  it('suspects the login after failures on >= 3 distinct servers with none online', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    expect(t.suspectsBadLogin('z1')).toBe(false);
    t.recordAuthFailure('z1', 'c');
    expect(t.suspectsBadLogin('z1')).toBe(true);
  });

  it('a repeated failure on the same server does not by itself reach the 3-server threshold', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'a');
    expect(t.suspectsBadLogin('z1')).toBe(false);
  });

  it('a success on one server lifts the suspicion for the account', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    t.recordAuthFailure('z1', 'c');
    expect(t.suspectsBadLogin('z1')).toBe(true);
    t.recordOnline('z1', 'd');
    expect(t.suspectsBadLogin('z1')).toBe(false);
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

  it('expired failures do not count toward the 3-server threshold', () => {
    let now = 0;
    const t = createRefusalTracker({ clock: () => now });
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    now += REFUSAL_TTL_MS + 1;
    t.recordAuthFailure('z1', 'c');
    // a and b have expired; only c is a live failure
    expect(t.suspectsBadLogin('z1')).toBe(false);
  });

  it('accounts are tracked independently', () => {
    const t = createRefusalTracker();
    t.recordAuthFailure('z1', 'a');
    t.recordAuthFailure('z1', 'b');
    t.recordAuthFailure('z1', 'c');
    expect(t.suspectsBadLogin('z1')).toBe(true);
    expect(t.suspectsBadLogin('z2')).toBe(false);
    expect(t.isRefused('z2', 'a')).toBe(false);
  });

  describe('clearOnline (reviewer item 9: a stopped/failed port is no longer evidence)', () => {
    it('clearing the only online marker makes the evidence count again', () => {
      const t = createRefusalTracker();
      t.recordOnline('z1', 'nl');
      for (const s of ['us', 'jp', 'de']) t.recordAuthFailure('z1', s);
      expect(t.suspectsBadLogin('z1')).toBe(false);
      t.clearOnline('z1', 'nl');
      expect(t.suspectsBadLogin('z1')).toBe(true);
    });

    it('an online marker expires on its own after ONLINE_TTL_MS even without an explicit clear', () => {
      let now = 0;
      const t = createRefusalTracker({ clock: () => now });
      t.recordOnline('z1', 'nl');
      for (const s of ['us', 'jp', 'de']) t.recordAuthFailure('z1', s);
      expect(t.suspectsBadLogin('z1')).toBe(false);
      now += ONLINE_TTL_MS + 1;
      expect(t.suspectsBadLogin('z1')).toBe(true);
    });
  });

  describe('serialize / initial (reviewer item 9: persist across restarts)', () => {
    it('serialize() reflects recorded failures and online markers as plain objects', () => {
      const t = createRefusalTracker({ clock: () => 42 });
      t.recordAuthFailure('z1', 'us');
      t.recordOnline('z1', 'nl');
      expect(t.serialize()).toEqual({ failures: { z1: { us: 42 } }, online: { z1: { nl: 42 } } });
    });

    it('a new tracker seeded with `initial` picks up where the old one left off', () => {
      const first = createRefusalTracker({ clock: () => 1000 });
      first.recordAuthFailure('z1', 'a');
      first.recordAuthFailure('z1', 'b');
      first.recordAuthFailure('z1', 'c');
      const snapshot = first.serialize();

      const second = createRefusalTracker({ initial: snapshot, clock: () => 1000 });
      expect(second.suspectsBadLogin('z1')).toBe(true);
      expect(second.isRefused('z1', 'a')).toBe(true);
    });

    it('a seeded tracker still honours the original clock-relative TTLs', () => {
      let now = 1000;
      const first = createRefusalTracker({ clock: () => now });
      first.recordAuthFailure('z1', 'us');
      const snapshot = first.serialize();

      now = 1000 + REFUSAL_TTL_MS + 1;
      const second = createRefusalTracker({ initial: snapshot, clock: () => now });
      expect(second.isRefused('z1', 'us')).toBe(false);
    });
  });
});
