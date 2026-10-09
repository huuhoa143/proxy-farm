import { randomBytes } from 'node:crypto';
import type { Account, AccountSecret, PortState, Provider, RenderInput, Target } from '../../shared/contracts';
import type { Engine } from './ports';
import type { AttemptLimiter } from './provider-safety';

/**
 * Live credential check (spec §5.2, "plan vs password").
 *
 * Over OpenVPN, ZoogVPN answers a wrong password and a server outside the account's plan
 * with the same `AUTH_FAILED`. Its free-tier hosts (`nl.zgfree.info`, `uk.zgfree.info`,
 * `us.zgfree.info`) take every valid login whatever the plan, so one handshake there
 * tells the two apart (✅ 2026-10-09: with the real credentials `nl.zgfree.info`
 * connected, exit 185.107.80.250; with a wrong password it failed auth).
 *
 * The probe is an ordinary engine start, through the same `Engine` (sing-box, config on
 * stdin, nothing on disk) and the same `Provider.bind` as a port, under a key no port
 * can have (`probe:<account>:<n>`), listening on loopback only. It waits for the tunnel
 * to come up (`verifying`, i.e. the server accepted the login) or for an auth failure,
 * then stops it. A network failure moves on to the next free host, at most `maxHosts`.
 * Every handshake takes a token from the account's attempt budget (spec §6.4).
 *
 * A provider with no plans at all (`Provider.anyServerChecksLogin`, ExpressVPN §5.6) has
 * no free tier but needs none: any of its servers tells a right login from a wrong one,
 * so the probe asks the nearest location's first server instead.
 */

/** Engine keys of credential probes. Port keys never start with it. */
export const PROBE_KEY_PREFIX = 'probe:';

export function isProbeKey(key: string): boolean {
  return key.startsWith(PROBE_KEY_PREFIX);
}

/**
 * - `ok`: a free host accepted the login → the credentials are right.
 * - `auth`: a free host refused the login → the credentials are wrong.
 * - `unreachable`: no free host could be asked (network, DNS, timeout, rate cap, no
 *   engine) → nothing is known.
 * - `unsupported`: the provider has no free-tier host to ask.
 */
export type ProbeOutcome = 'ok' | 'auth' | 'unreachable' | 'unsupported';

export interface ProbeResult {
  outcome: ProbeOutcome;
  /** The free host that decided it (`ok`/`auth`). */
  host?: string;
}

export type CredentialProbe = (account: Account, secret: AccountSecret, provider: Provider) => Promise<ProbeResult>;

export interface CredentialProbeDeps {
  engine: Engine;
  /** Hostname → IPv4 (the controller resolves before bind, spec §6.1.4). */
  resolveServer(server: string): Promise<string>;
  /** A free loopback port for the probe's proxy inbound, held for it until `releasePort`. */
  allocatePort(): Promise<number>;
  /** The probe's engine for `port` has stopped: the port may be handed out again. */
  releasePort?(port: number): void;
  /** The account's handshake budget, shared with its ports. */
  limiter: AttemptLimiter;
  /** Per host: how long to wait for "established" or an auth failure. @default 40_000 */
  timeoutMs?: number;
  /** Free hosts tried at most. @default 2 */
  maxHosts?: number;
  /** Longest wait for an attempt token before giving up as `unreachable`. @default 15_000 */
  maxRateWaitMs?: number;
  /** IANA time zone used to pick the nearest host. @default the system's */
  timeZone?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface FreeHost {
  server: string;
  country: string;
  target: Target;
}

/** Every free-tier host of the provider's locations, in catalog order. */
export function freeHosts(targets: readonly Target[]): FreeHost[] {
  const out: FreeHost[] = [];
  for (const target of targets) for (const server of target.freeTierServers ?? []) out.push({ server, country: target.country, target });
  return out;
}

/**
 * The servers a credential probe may ask, in catalog order: the free-tier hosts, or, for
 * a provider whose every server checks the login (`anyServerChecksLogin`), the first
 * server of each location that stands where it says (not virtual).
 */
export function loginCheckHosts(targets: readonly Target[], provider: Pick<Provider, 'anyServerChecksLogin'>): FreeHost[] {
  const free = freeHosts(targets);
  if (free.length > 0 || !provider.anyServerChecksLogin) return free;
  return targets
    .filter((t) => !t.virtualLocation && t.servers.length > 0)
    .map((target) => ({ server: target.servers[0], country: target.country, target }));
}

const EUROPE = new Set(['AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LT', 'LU', 'LV', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'UA']);
const AMERICAS = new Set(['AR', 'BR', 'CA', 'CL', 'CO', 'CR', 'MX', 'PA', 'PE', 'US', 'UY', 'VE']);
const ASIA = new Set(['BD', 'BN', 'BT', 'HK', 'ID', 'IN', 'JP', 'KH', 'KR', 'LA', 'LK', 'MM', 'MN', 'MO', 'MY', 'NP', 'PH', 'SG', 'TH', 'TW', 'VN']);

/**
 * Hosts nearest first, judged from the system time zone (no network needed): from the
 * Americas and the Pacific (Australia, New Zealand) the US is closer, from Europe and
 * Africa it is Europe, from Asia a host in Asia and then Europe. Ties keep catalog order.
 */
export function orderByProximity(hosts: readonly FreeHost[], timeZone: string): FreeHost[] {
  const area = timeZone.split('/')[0];
  const americasFirst = area === 'America' || area === 'Pacific' || area === 'Australia' || area === 'Antarctica';
  const asiaFirst = area === 'Asia';
  const rank = (cc: string): number => {
    if (americasFirst) return AMERICAS.has(cc) ? 0 : EUROPE.has(cc) ? 1 : 2;
    if (asiaFirst) return ASIA.has(cc) ? 0 : EUROPE.has(cc) ? 1 : AMERICAS.has(cc) ? 2 : 3;
    return EUROPE.has(cc) ? 0 : AMERICAS.has(cc) ? 1 : 2;
  };
  return hosts
    .map((h, i) => ({ h, i }))
    .sort((a, b) => rank(a.h.country) - rank(b.h.country) || a.i - b.i)
    .map(({ h }) => h);
}

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

const DEFAULT_TIMEOUT_MS = 40_000;

export function createCredentialProbe(deps: CredentialProbeDeps): CredentialProbe {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHosts = deps.maxHosts ?? 2;
  const maxRateWaitMs = deps.maxRateWaitMs ?? 15_000;
  const timeZone = deps.timeZone ?? systemTimeZone;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let seq = 0;

  /** One attempt token, waiting for it if it comes soon enough. */
  async function takeAttempt(accountId: string): Promise<boolean> {
    const wait = deps.limiter.take(accountId);
    if (wait === 0) return true;
    if (wait > maxRateWaitMs) return false;
    await sleep(wait);
    return deps.limiter.take(accountId) === 0;
  }

  /** One handshake with one free host: 'ok' | 'auth' | 'unreachable'. */
  function handshake(key: string, input: RenderInput): Promise<'ok' | 'auth' | 'unreachable'> {
    return new Promise<'ok' | 'auth' | 'unreachable'>((resolve) => {
      let settled = false;
      const finish = (outcome: 'ok' | 'auth' | 'unreachable') => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(outcome);
      };
      const unsubscribe = deps.engine.onStateChange((k: string, st: PortState) => {
        if (k !== key) return;
        // `verifying` = the tunnel is up: the server accepted the login.
        if (st.kind === 'verifying' || st.kind === 'online') finish('ok');
        else if (st.kind === 'failed') finish(st.reason === 'auth' ? 'auth' : 'unreachable');
        else if (st.kind === 'retrying' || st.kind === 'stopped') finish('unreachable');
      });
      const timer = setTimeout(() => finish('unreachable'), timeoutMs);
      timer.unref?.();
      deps.engine.start(key, input).catch(() => finish('unreachable'));
    }).finally(() => deps.engine.stop(key).catch(() => undefined));
  }

  return async (account, secret, provider) => {
    const hosts = orderByProximity(loginCheckHosts(await provider.targets(account), provider), timeZone());
    if (hosts.length === 0) return { outcome: 'unsupported' };
    for (const host of hosts.slice(0, maxHosts)) {
      let ip: string;
      try {
        ip = await deps.resolveServer(host.server);
      } catch {
        continue; // DNS: try the next host
      }
      if (!(await takeAttempt(account.id))) return { outcome: 'unreachable' };
      let port: number;
      try {
        port = await deps.allocatePort();
      } catch {
        return { outcome: 'unreachable' };
      }
      const input: RenderInput = {
        endpoint: provider.bind(host.target, ip, account, secret),
        // Loopback, with throwaway proxy credentials: nothing else may use the tunnel.
        listen: { host: '127.0.0.1', port, proxyAuth: { username: 'probe', password: randomBytes(12).toString('hex') } },
        clash: { port: 0, secret: '' }, // the engine allocates its own
      };
      seq += 1;
      const outcome = await handshake(`${PROBE_KEY_PREFIX}${account.id}:${seq}`, input).finally(() => deps.releasePort?.(port));
      if (outcome !== 'unreachable') return { outcome, host: host.server };
    }
    return { outcome: 'unreachable' };
  };
}
