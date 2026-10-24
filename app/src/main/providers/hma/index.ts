/**
 * HMA provider — OpenVPN over HMA's Avast/NLOK "se-platform" backend (docs/HMA-SE-PLATFORM.md).
 *
 * proxy-farm registers its own device from the user's subscription license key, mints its
 * own token, and discovers fresh gateway IPs the way the real HMA app does — a large,
 * rotating pool, not a fixed list. The device's OpenVPN username/password are the account's
 * `userpass` secret; its durable identity (license, machine fingerprint, tenant, container,
 * udid, CA) lives in `account.meta`. `bind()` connects OpenVPN to a discovered gen-vpn.com
 * gateway with those credentials and the device's own CA.
 */
import type { Account, AccountSecret, Catalog, CheckResult, Provider, Target } from '../types';
import { fetchDeviceCredentials, SeError } from './se-platform/client';
import type { SeCatalogStore } from './se-platform/catalog-store';
import {
  createTokenMinter,
  identityFromMeta,
  identityToMeta,
  registerDevice,
  type DeviceIdentity,
  type TokenMinter,
} from './se-platform/device';
import type { SeFetch } from './se-platform/types';

const SERVER_PORT = 1194;
const SERVER_NAME = 'openvpn.gen-vpn.com';
const MTU = 1400;

const UDID_RE = /^U1\./;
const PASSWORD_RE = /^[0-9a-fA-F]{64}$/;

/** Fields `identityToMeta` writes into `account.meta`, copied through `check`. */
const SE_META_KEYS = ['source', 'walletKey', 'deviceFingerprint', 'tenant', 'containerId', 'deviceUdid', 'openvpnCa'] as const;

export interface HmaSePlatformDeps {
  store: SeCatalogStore;
  net: SeFetch;
  now?: () => number;
}

export interface HmaProviderDeps {
  sePlatform?: HmaSePlatformDeps;
}

function seErrorKey(err: unknown): string {
  if (err instanceof SeError) {
    if (err.kind === 'network') return 'hma.sePlatform.network';
    if (err.kind === 'noLicense') return 'hma.sePlatform.noLicense';
    if (err.kind === 'unauthorized') return 'hma.sePlatform.unauthorized';
  }
  return 'hma.sePlatform.failed';
}

/** Target.servers best-first: most recently confirmed-ok IP first (never-confirmed last),
 * longest-known first as a tiebreak (spec §6.8). */
function bestFirst(ips: Catalog['locations'][number]['ips']): string[] {
  return [...ips]
    .sort((a, b) => {
      if (a.lastOk !== b.lastOk) {
        if (a.lastOk === null) return 1;
        if (b.lastOk === null) return -1;
        return b.lastOk - a.lastOk;
      }
      return b.firstSeen - a.firstSeen;
    })
    .map((ip) => ip.ip);
}

/** Strip the `hma:` prefix a `Target.key` carries to get the se-platform location_key. */
function locationKeyOf(targetKey: string): string {
  return targetKey.startsWith('hma:') ? targetKey.slice(4) : targetKey;
}

export function createHmaProvider(deps: HmaProviderDeps = {}): Provider {
  const se = deps.sePlatform;
  const minters = new Map<string, TokenMinter>();

  function minterFor(identity: DeviceIdentity): TokenMinter {
    let m = minters.get(identity.deviceUdid);
    if (!m) {
      m = createTokenMinter(identity, se!.net, { now: se?.now });
      minters.set(identity.deviceUdid, m);
    }
    return m;
  }

  return {
    id: 'hma',

    /** Register a device from the license key (`licenseKey`), reusing an existing
     * fingerprint/tenant when re-adding so it never burns a fresh license device slot. */
    async resolveInput(input: Record<string, string>) {
      const licenseKey = (input.licenseKey ?? input.walletKey ?? '').trim();
      if (!licenseKey) return { reasonKey: 'hma.sePlatform.needsLicense' };
      if (!se) return { reasonKey: 'hma.sePlatform.unavailable' };
      try {
        const dev = await registerDevice(licenseKey, se.net, {
          now: se.now,
          deviceFingerprint: input.deviceFingerprint || undefined,
          tenant: input.tenant || undefined,
        });
        minters.set(
          dev.identity.deviceUdid,
          createTokenMinter(dev.identity, se.net, { now: se.now, seedToken: dev.accessToken }),
        );
        return { input: { ...identityToMeta(dev.identity), udid: dev.username, password: dev.password } };
      } catch (err) {
        return { reasonKey: seErrorKey(err) };
      }
    },

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const udid = input.udid ?? '';
      const password = input.password ?? '';

      if (!UDID_RE.test(udid)) return { ok: false, reasonKey: 'hma.check.invalidUdid' };
      if (!PASSWORD_RE.test(password)) return { ok: false, reasonKey: 'hma.check.invalidPassword' };

      const meta: Record<string, string> = { udid };
      if (input.source === 'se-platform') for (const k of SE_META_KEYS) if (input[k]) meta[k] = input[k];
      return {
        ok: true,
        label: `device …${udid.slice(-6)}`,
        secret: { kind: 'userpass', username: udid, password },
        meta,
      };
    },

    async targets(account: Account): Promise<Target[]> {
      const identity = identityFromMeta(account.meta);
      if (!identity || !se) return [];
      const ctx = { minter: minterFor(identity), tenant: identity.tenant };
      const geos = await se.store.geos(ctx).catch(() => []);
      se.store.kickRefresh(ctx);
      // Show the FULL location list the HMA app shows — every active geos city, whether or
      // not discover has cached a gateway for it yet. Undiscovered cities come back with an
      // empty `servers`; they stay selectable (HMA is a dynamic provider) and get their
      // gateways discovered on Add / Change IP. `servers` carries whatever IPs are cached.
      const byKey = new Map(se.store.snapshot().locations.map((loc) => [loc.key, loc]));
      const out: Target[] = [];
      for (const g of geos) {
        for (const c of g.cities) {
          if (!c.active) continue;
          const loc = byKey.get(c.locationKey);
          out.push({
            key: `hma:${c.locationKey}`,
            providerId: 'hma' as const,
            country: g.countryCode,
            city: c.city,
            label: `${g.countryName} — ${c.city}`,
            servers: loc ? bestFirst(loc.ips) : [],
          });
        }
      }
      return out;
    },

    async refreshLocation(account: Account, locationKey: string): Promise<void> {
      const identity = identityFromMeta(account.meta);
      if (!identity || !se) return;
      await se.store
        .refreshOne({ minter: minterFor(identity), tenant: identity.tenant }, locationKeyOf(locationKey))
        .catch(() => undefined);
    },

    async refreshAll(account: Account): Promise<void> {
      const identity = identityFromMeta(account.meta);
      if (!identity || !se) return;
      await se.store.refreshAll({ minter: minterFor(identity), tenant: identity.tenant }).catch(() => undefined);
    },

    async refreshCredentials(account: Account) {
      const identity = identityFromMeta(account.meta);
      if (!identity || !se) return undefined;
      try {
        const token = await minterFor(identity).getToken();
        const creds = await fetchDeviceCredentials({ deviceUdid: identity.deviceUdid, tenantId: identity.tenant, token }, se.net);
        const refreshed: DeviceIdentity = { ...identity, openvpnCaCertificate: creds.openvpnCaCertificate };
        return {
          secret: { kind: 'userpass' as const, username: creds.deviceUdid, password: creds.devicePassword },
          meta: identityToMeta(refreshed),
        };
      } catch {
        return undefined;
      }
    },

    bind(target: Target, serverIp: string, account: Account, secret: AccountSecret) {
      if (secret.kind !== 'userpass') {
        throw new Error('hma: bind() requires a userpass secret (username = udid, password = device password)');
      }
      const identity = identityFromMeta(account.meta);
      if (!identity) throw new Error('hma: account has no se-platform device identity (openvpn CA)');
      return {
        type: 'openvpn-client' as const,
        server: serverIp,
        server_port: SERVER_PORT,
        network: 'udp' as const,
        username: secret.username,
        password: secret.password,
        tls: {
          certificate: identity.openvpnCaCertificate.split(/\r?\n/).filter((line) => line.length > 0),
          server_name: SERVER_NAME,
          remote_certificate_tls: 'server' as const,
        },
        data_ciphers: ['AES-256-GCM'],
        data_ciphers_fallback: 'AES-256-GCM',
        route_no_pull: true as const,
        explicit_exit_notify: 2,
        mtu: MTU,
      };
    },
  };
}

export const hmaProvider = createHmaProvider();
