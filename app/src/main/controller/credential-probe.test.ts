import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, AccountSecret, EndpointSpec, PortState, Provider, RenderInput, Target } from '../../shared/contracts';
import { createCredentialProbe, freeHosts, isProbeKey, loginCheckHosts, orderByProximity, PROBE_KEY_PREFIX, type CredentialProbeDeps } from './credential-probe';
import type { Engine } from './ports';

const account: Account = { id: 'zoogvpn-1', providerId: 'zoogvpn', label: 'me@example.com', meta: {}, secretRef: 'account:zoogvpn-1' };
const secret: AccountSecret = { kind: 'userpass', username: 'me@example.com', password: 'pw' };

const loc = (key: string, country: string, servers: string[], free: string[] = []): Target => ({
  key,
  providerId: 'zoogvpn',
  country,
  city: country,
  label: country,
  servers,
  ...(free.length ? { freeTierServers: free } : {}),
});

/** The bundled catalog's three free hosts (✅ 2026-10-09), in catalog order. */
const catalog: Target[] = [
  loc('zoogvpn:GB', 'GB', ['uk1.webunlim.com', 'uk.zgfree.info'], ['uk.zgfree.info']),
  loc('zoogvpn:JP', 'JP', ['jp1.webunlim.com']),
  loc('zoogvpn:NL', 'NL', ['nl1.webunlim.com', 'nl.zgfree.info'], ['nl.zgfree.info']),
  loc('zoogvpn:US', 'US', ['us.zgfree.info'], ['us.zgfree.info']),
];

const DNS: Record<string, string> = { 'uk.zgfree.info': '10.0.0.44', 'nl.zgfree.info': '185.107.80.250', 'us.zgfree.info': '10.0.0.11' };

function provider(targets: Target[] = catalog): Provider & { binds: string[] } {
  const binds: string[] = [];
  return {
    id: 'zoogvpn',
    binds,
    check: () => ({ ok: true }),
    targets: async () => targets,
    bind: (_t, ip, _a, s): EndpointSpec => {
      binds.push(ip);
      return {
        type: 'openvpn-client',
        server: ip,
        server_port: 1194,
        network: 'udp',
        username: s.kind === 'userpass' ? s.username : '',
        password: s.kind === 'userpass' ? s.password : '',
        tls: { certificate: ['x'] },
        data_ciphers: ['AES-256-GCM'],
        route_no_pull: true,
        mtu: 1400,
      };
    },
  };
}

/** Each start answers with the next scripted state for its key (or never, for `null`). */
function scriptedEngine(answers: Array<PortState | null | 'throw'>) {
  const cbs = new Set<(key: string, st: PortState) => void>();
  const started: Array<{ key: string; input: RenderInput }> = [];
  const stopped: string[] = [];
  const engine: Engine = {
    async start(key, input) {
      started.push({ key, input });
      const next = answers.shift();
      if (next === 'throw') throw new Error('sing-box missing');
      if (next) setTimeout(() => cbs.forEach((cb) => cb(key, next)), 0);
    },
    async stop(key) {
      stopped.push(key);
    },
    probe: async () => ({ code: 200, ms: 1 }),
    getLogs: () => [],
    onStateChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
  return { engine, started, stopped, listeners: () => cbs.size };
}

const verifying: PortState = { kind: 'verifying', since: 1 };
const authFailed: PortState = { kind: 'failed', reason: 'auth', untilMs: 0, attempt: 1 };
const unreachable: PortState = { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'unreachable' };

function deps(engine: Engine, over: Partial<CredentialProbeDeps> = {}): CredentialProbeDeps {
  return {
    engine,
    resolveServer: async (s) => {
      const ip = DNS[s];
      if (!ip) throw new Error(`ENOTFOUND ${s}`);
      return ip;
    },
    allocatePort: async () => 39001,
    limiter: { take: () => 0 },
    timeZone: () => 'Asia/Ho_Chi_Minh',
    ...over,
  };
}

afterEach(() => vi.useRealTimers());

describe('free hosts and proximity', () => {
  it('lists every free-tier server with its location', () => {
    expect(freeHosts(catalog).map((h) => [h.server, h.country])).toEqual([
      ['uk.zgfree.info', 'GB'],
      ['nl.zgfree.info', 'NL'],
      ['us.zgfree.info', 'US'],
    ]);
  });

  it('nearest first from the time zone: Europe for Asia/Europe/Africa, the US for the Americas and Oceania', () => {
    const order = (tz: string) => orderByProximity(freeHosts(catalog), tz).map((h) => h.country);
    expect(order('Asia/Ho_Chi_Minh')).toEqual(['GB', 'NL', 'US']);
    expect(order('Europe/Amsterdam')).toEqual(['GB', 'NL', 'US']);
    expect(order('America/New_York')).toEqual(['US', 'GB', 'NL']);
    expect(order('Australia/Sydney')).toEqual(['US', 'GB', 'NL']);
    expect(order('')).toEqual(['GB', 'NL', 'US']);
  });

  it('from Asia, a host in Asia comes before Europe; free-tier order is unchanged (none in Asia)', () => {
    const asia = loc('expressvpn:SG', 'SG', ['203.0.113.5']);
    const order = (tz: string) => orderByProximity([...freeHosts(catalog), { server: '203.0.113.5', country: 'SG', target: asia }], tz).map((h) => h.country);
    expect(order('Asia/Ho_Chi_Minh')).toEqual(['SG', 'GB', 'NL', 'US']);
    expect(order('Europe/Amsterdam')).toEqual(['GB', 'NL', 'US', 'SG']);
    expect(order('America/New_York')).toEqual(['US', 'GB', 'NL', 'SG']);
  });

  it('probe keys never look like port keys', () => {
    expect(isProbeKey(`${PROBE_KEY_PREFIX}zoogvpn-1:1`)).toBe(true);
    expect(isProbeKey('zoogvpn:NL#1')).toBe(false);
  });
});

describe('credential probe (spec §5.2)', () => {
  it('gives each host attempt\'s proxy port back once its engine has stopped, whatever the outcome', async () => {
    const e = scriptedEngine([{ kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'timeout' }, verifying]);
    const events: string[] = [];
    const stop = e.engine.stop;
    e.engine.stop = async (key) => {
      events.push(`stop ${key}`);
      return stop(key);
    };
    let next = 39001;
    const probe = createCredentialProbe(
      deps(e.engine, {
        allocatePort: async () => next++,
        releasePort: (port) => void events.push(`release ${port}`),
      }),
    );
    expect(await probe(account, secret, provider())).toEqual({ outcome: 'ok', host: 'nl.zgfree.info' });
    expect(events).toEqual([`stop ${PROBE_KEY_PREFIX}zoogvpn-1:1`, 'release 39001', `stop ${PROBE_KEY_PREFIX}zoogvpn-1:2`, 'release 39002']);
  });

  it('a free host that brings the tunnel up → ok; the probe runs as an engine start on loopback, then stops', async () => {
    const e = scriptedEngine([verifying]);
    const p = provider();
    const result = await createCredentialProbe(deps(e.engine))(account, secret, p);
    expect(result).toEqual({ outcome: 'ok', host: 'uk.zgfree.info' });
    expect(e.started).toHaveLength(1);
    const { key, input } = e.started[0];
    expect(key.startsWith(PROBE_KEY_PREFIX)).toBe(true);
    expect(input.listen).toMatchObject({ host: '127.0.0.1', port: 39001, proxyAuth: { username: 'probe' } });
    expect(input.endpoint).toMatchObject({ server: '10.0.0.44', username: 'me@example.com', password: 'pw' }); // over stdin, via bind
    expect(e.stopped).toEqual([key]);
    expect(e.listeners()).toBe(0);
  });

  it('an auth failure on a free host → auth (the password is wrong); no second host', async () => {
    const e = scriptedEngine([authFailed]);
    expect(await createCredentialProbe(deps(e.engine))(account, secret, provider())).toEqual({ outcome: 'auth', host: 'uk.zgfree.info' });
    expect(e.started).toHaveLength(1);
    expect(e.stopped).toHaveLength(1);
  });

  it('a network failure moves to the next free host, at most two hosts', async () => {
    const e = scriptedEngine([unreachable, verifying]);
    const p = provider();
    expect(await createCredentialProbe(deps(e.engine))(account, secret, p)).toEqual({ outcome: 'ok', host: 'nl.zgfree.info' });
    expect(p.binds).toEqual(['10.0.0.44', '185.107.80.250']);

    const e2 = scriptedEngine([unreachable, { kind: 'retrying', untilMs: 0, attempt: 1, reasonKey: 'exited' }, verifying]);
    expect(await createCredentialProbe(deps(e2.engine))(account, secret, provider())).toEqual({ outcome: 'unreachable' });
    expect(e2.started).toHaveLength(2); // never a third
    expect(e2.stopped).toHaveLength(2);
  });

  it('a host that does not resolve is skipped', async () => {
    const e = scriptedEngine([verifying]);
    const r = await createCredentialProbe(deps(e.engine, { resolveServer: async (s) => (s === 'uk.zgfree.info' ? Promise.reject(new Error('ENOTFOUND')) : DNS[s]) }))(account, secret, provider());
    expect(r).toEqual({ outcome: 'ok', host: 'nl.zgfree.info' });
  });

  it('no answer within the timeout → unreachable, and the engine is stopped', async () => {
    vi.useFakeTimers();
    const e = scriptedEngine([null, null]);
    const run = createCredentialProbe(deps(e.engine, { timeoutMs: 40_000 }))(account, secret, provider());
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await run).toEqual({ outcome: 'unreachable' });
    expect(e.started).toHaveLength(2);
    expect(e.stopped).toHaveLength(2);
  });

  it('an engine that cannot start → unreachable', async () => {
    const e = scriptedEngine(['throw', 'throw']);
    expect(await createCredentialProbe(deps(e.engine))(account, secret, provider())).toEqual({ outcome: 'unreachable' });
  });

  it('takes from the account attempt budget: waits for a token due soon, gives up on a long wait', async () => {
    const takes: string[] = [];
    const sleep = vi.fn(async () => undefined);
    let budget = [4_000, 0];
    const e = scriptedEngine([verifying]);
    const probe = createCredentialProbe(deps(e.engine, { sleep, limiter: { take: (id) => (takes.push(id), budget.shift() ?? 0) } }));
    expect((await probe(account, secret, provider())).outcome).toBe('ok');
    expect(takes).toEqual(['zoogvpn-1', 'zoogvpn-1']);
    expect(sleep).toHaveBeenCalledWith(4_000);

    budget = [60_000];
    const e2 = scriptedEngine([verifying]);
    const slow = createCredentialProbe(deps(e2.engine, { sleep, limiter: { take: () => budget.shift() ?? 0 } }));
    expect(await slow(account, secret, provider())).toEqual({ outcome: 'unreachable' });
    expect(e2.started).toHaveLength(0);
  });

  it('a provider without free-tier servers → unsupported, nothing started', async () => {
    const e = scriptedEngine([verifying]);
    expect(await createCredentialProbe(deps(e.engine))(account, secret, provider([catalog[1]]))).toEqual({ outcome: 'unsupported' });
    expect(e.started).toHaveLength(0);
  });
});

describe('credential probe: a provider whose every server checks the login (ExpressVPN, spec §5.6)', () => {
  const xloc = (key: string, country: string, servers: string[], virtual = false): Target => ({
    key,
    providerId: 'expressvpn',
    country,
    city: '',
    label: country,
    servers,
    ...(virtual ? { virtualLocation: true } : {}),
  });
  const express: Target[] = [
    xloc('expressvpn:AL', 'AL', ['192.0.2.1']),
    xloc('expressvpn:IN-VIA-SINGAPORE', 'IN', ['192.0.2.9'], true),
    xloc('expressvpn:VN', 'VN', ['192.0.2.20', '192.0.2.21']),
    xloc('expressvpn:US-NEW-YORK', 'US', ['usa-newyork-ca-version-2.expressnetw.com']),
  ];
  const anyServer = (targets: Target[]) => ({ ...provider(targets), id: 'expressvpn' as const, anyServerChecksLogin: true });

  it('asks the first server of each location that is not virtual; free-tier providers keep their free hosts only', () => {
    expect(loginCheckHosts(express, anyServer(express)).map((h) => h.server)).toEqual(['192.0.2.1', '192.0.2.20', 'usa-newyork-ca-version-2.expressnetw.com']);
    expect(loginCheckHosts(express, provider(express))).toEqual([]);
    expect(loginCheckHosts(catalog, { ...provider(), anyServerChecksLogin: true }).map((h) => h.server)).toEqual(['uk.zgfree.info', 'nl.zgfree.info', 'us.zgfree.info']);
  });

  it('a server that brings the tunnel up → ok, one handshake, nearest location first', async () => {
    const e = scriptedEngine([verifying]);
    const p = anyServer(express);
    const result = await createCredentialProbe(deps(e.engine, { resolveServer: async (s) => s }))(account, secret, p);
    expect(result).toEqual({ outcome: 'ok', host: '192.0.2.20' });
    expect(e.started).toHaveLength(1);
  });

  it('an auth failure → auth (wrong username or password)', async () => {
    const e = scriptedEngine([authFailed]);
    const result = await createCredentialProbe(deps(e.engine, { resolveServer: async (s) => s }))(account, secret, anyServer(express));
    expect(result.outcome).toBe('auth');
  });
});

