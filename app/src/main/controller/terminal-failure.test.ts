/**
 * Regression (0.1.0, live 2026-10-09): a ZoogVPN port whose location had nothing left
 * but servers outside the plan ended `failed(not-in-plan)` with `attempt: 1`, and the UI
 * said it would not retry — yet a new engine started about every 41 s, each time on a
 * refused server, and the attempt count never grew.
 *
 * The path: `PortHealth` armed its back-off timer for `failed(auth)` like for any other
 * failure; port-manager rewrote the reason to `not-in-plan` but left the timer (and the
 * engine entry) alive; when it fired, `onRetryDue` → `startPort` → a 'restart' selection
 * that falls back to refused servers → `engine.start`. The main process's engine wrapper
 * also dropped `startPort`'s `{attempt}`, so every new `PortHealth` began at the 30 s
 * step (≈26 s `untilMs` gap + the handshake ≈ 41 s).
 *
 * These tests drive port-manager with the REAL `PortHealth` (as the real engine adapter
 * does) on fake timers, and assert that after a terminal failure nothing starts again
 * until the user acts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, EndpointSpec, PortRow, PortState, Provider, ProviderId, RenderInput, Target } from '../../shared/contracts';
import { PortHealth } from '../health/state-machine';
import type { SecretStore } from '../store/secrets';
import { createStateStore } from '../store/state';
import { createPortManager } from './port-manager';
import type { Engine } from './ports';
import { createServerHealth } from './server-health';

function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    saveSecret: (id, v) => void map.set(id, v),
    loadSecret: (id) => map.get(id) ?? null,
    deleteSecret: (id) => void map.delete(id),
  };
}

/** An engine whose per-port state comes from a real `PortHealth`, wired like
 * engine-adapter.ts: transitions go to `onStateChange`, a due back-off to `onRetryDue`. */
function healthEngine() {
  const healths = new Map<string, { health: PortHealth; unsub: Array<() => void> }>();
  const stateCbs = new Set<(key: string, state: PortState) => void>();
  const retryCbs = new Set<(key: string) => void>();
  const starts: Array<{ key: string; server: string; attempt?: number }> = [];
  function teardown(key: string): void {
    const entry = healths.get(key);
    if (!entry) return;
    for (const u of entry.unsub) u();
    entry.health.stop();
    healths.delete(key);
  }
  const engine: Engine = {
    async start(key: string, input: RenderInput, opts) {
      teardown(key);
      const ep = input.endpoint;
      starts.push({ key, server: ep.type === 'openvpn-client' ? ep.server : ep.peers[0].address, attempt: opts?.attempt });
      const health = new PortHealth({ initialAttempt: opts?.attempt });
      const unsub = [
        health.onStateChange((st) => {
          for (const cb of stateCbs) cb(key, st);
        }),
        health.onRetryDue(() => {
          for (const cb of retryCbs) cb(key);
        }),
      ];
      healths.set(key, { health, unsub });
      health.start();
    },
    async stop(key) {
      teardown(key);
    },
    probe: async () => ({ code: 200, ms: 1 }),
    getLogs: () => [],
    onStateChange(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onRetryDue(cb) {
      retryCbs.add(cb);
      return () => retryCbs.delete(cb);
    },
  };
  return {
    engine,
    starts,
    running: () => [...healths.keys()],
    /** sing-box logs `authentication failed: terminal` for this port. */
    refuse: (key: string) => healths.get(key)?.health.feedLog('auth-terminal'),
    online: (key: string, exitIp: string) => {
      const h = healths.get(key)!.health;
      h.feedLog('established');
      h.feedEstablishedThenVerify(true, { exitIp, country: 'XX' });
    },
  };
}

function openvpnProvider(id: ProviderId, targets: Target[]): Provider {
  return {
    id,
    check: () => ({ ok: true }),
    targets: async () => targets,
    bind: (_t, serverIp): EndpointSpec => ({
      type: 'openvpn-client',
      server: serverIp,
      server_port: 1194,
      network: 'udp',
      username: 'u',
      password: 'p',
      tls: { certificate: ['x'] },
      data_ciphers: ['AES-256-GCM'],
      route_no_pull: true,
      mtu: 1400,
    }),
  };
}

function row(key: string, providerId: ProviderId, locationKey: string, proxyPort: number, server?: string): PortRow {
  return {
    key,
    locationKey,
    providerId,
    accountId: 'a1',
    label: 'X',
    country: 'JP',
    city: 'Japan',
    proxyPort,
    enabled: true,
    state: { kind: 'queued' },
    autoRotateMin: 0,
    ...(server ? { server } : {}),
  };
}

describe('terminal failures stay terminal (no timer, no engine until the user acts)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-terminal-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(providerId: ProviderId, servers: string[], ports: PortRow[]) {
    const secrets = memorySecrets();
    secrets.saveSecret('a1-secret', JSON.stringify({ kind: 'userpass', username: 'u', password: 'p' }));
    const state = createStateStore(join(dir, 'state.json'), secrets);
    const account: Account = { id: 'a1', providerId, label: 'a1', meta: {}, secretRef: 'a1-secret' };
    const target: Target = { key: `${providerId}:JP`, providerId, country: 'JP', city: 'Japan', label: 'Japan', servers };
    state.setState((s) => ({ ...s, accounts: [account], ports }));
    const eng = healthEngine();
    const serverHealth = createServerHealth();
    const manager = createPortManager({
      state,
      secrets,
      engine: eng.engine,
      providers: { get: () => openvpnProvider(providerId, [target]) },
      exitIp: { probe: async () => ({ ip: '0.0.0.0', country: 'XX' }) },
      allocator: { allocate: async () => 29001, allocateAux: async () => 40000, release: () => undefined },
      resolveServer: async (s) => s,
      serverHealth,
      attemptLimiter: { take: () => 0 },
    });
    const stateOf = (key: string) => state.getState().ports.find((p) => p.key === key)!.state;
    return { manager, state, eng, serverHealth, stateOf };
  }

  it('ZoogVPN: a location exhausted by plan refusals ends failed(not-in-plan) and never starts an engine again', async () => {
    // #1 is online on jp1 (the login works), so a refusal on another server is the plan.
    const { manager, eng, stateOf } = setup('zoogvpn', ['10.0.0.1', '10.0.0.2', '10.0.0.3'], [
      row('zoogvpn:JP#1', 'zoogvpn', 'zoogvpn:JP', 29001, '10.0.0.1'),
      row('zoogvpn:JP#2', 'zoogvpn', 'zoogvpn:JP', 29002, '10.0.0.2'),
    ]);
    await manager.startPort('zoogvpn:JP#1');
    eng.online('zoogvpn:JP#1', '10.0.0.1');
    await manager.startPort('zoogvpn:JP#2');
    eng.refuse('zoogvpn:JP#2'); // jp2 refuses → moves to jp3
    await vi.advanceTimersByTimeAsync(0);
    expect(eng.starts.map((s) => s.server)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    eng.refuse('zoogvpn:JP#2'); // jp3 refuses → nothing left
    await vi.advanceTimersByTimeAsync(0);
    expect(stateOf('zoogvpn:JP#2')).toMatchObject({ kind: 'failed', reason: 'not-in-plan' });
    expect(eng.running()).toEqual(['zoogvpn:JP#1']); // its engine is gone too

    const startsAtFailure = eng.starts.length;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000); // two hours of timers
    expect(eng.starts.length - startsAtFailure).toBe(0);
    // An automatic start (resume, app start, a settings change) leaves it alone too.
    await manager.startPort('zoogvpn:JP#2');
    expect(await manager.rotatePort('zoogvpn:JP#2')).toEqual({ changed: false, noteKey: 'needs-attention' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(eng.starts.length - startsAtFailure).toBe(0);
    expect(stateOf('zoogvpn:JP#2')).toMatchObject({ kind: 'failed', reason: 'not-in-plan' });

    // The user's Start is the one thing that tries again.
    await manager.startPort('zoogvpn:JP#2', { user: true });
    expect(eng.starts.length - startsAtFailure).toBe(1);
  });

  it('HMA: rejected device credentials end failed(auth) with no timer and no engine', async () => {
    const { manager, eng, stateOf } = setup('hma', ['10.9.0.1', '10.9.0.2'], [row('hma:JP#1', 'hma', 'hma:JP', 29001)]);
    await manager.startPort('hma:JP#1');
    eng.refuse('hma:JP#1');
    await vi.advanceTimersByTimeAsync(0);
    expect(stateOf('hma:JP#1')).toMatchObject({ kind: 'failed', reason: 'auth' });
    expect(eng.running()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(eng.starts).toHaveLength(1);
  });

  it('a back-off keeps growing across engine restarts instead of restarting at 30 s', async () => {
    const { manager, eng } = setup('zoogvpn', ['10.0.0.1'], [row('zoogvpn:JP#1', 'zoogvpn', 'zoogvpn:JP', 29001, '10.0.0.1')]);
    await manager.startPort('zoogvpn:JP#1');
    // Each round: the 90 s connecting deadline drops it to retrying, then the back-off
    // (30 s, 1 min, 2 min, each ±20 %) elapses and the port is started again.
    for (const backoffMs of [36_000, 72_000, 144_000]) {
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(backoffMs);
    }
    expect(eng.starts.map((s) => s.attempt)).toEqual([0, 1, 2, 3]);
  });
});
