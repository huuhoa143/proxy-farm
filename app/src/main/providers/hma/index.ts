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
import { fetchDeviceCredentials, SeError, tenantOfUdid } from './se-platform/client';
import type { SeCatalogStore } from './se-platform/catalog-store';
import {
  createTokenMinter,
  identityFromMeta,
  identityToMeta,
  licenseHint,
  registerDevice,
  withToken,
  type DeviceIdentity,
  type TokenMinter,
} from './se-platform/device';
import type { SeDeviceToken, SeFetch } from './se-platform/types';

const SERVER_PORT = 1194;
const SERVER_NAME = 'openvpn.gen-vpn.com';
const MTU = 1400;

const UDID_RE = /^U1\./;
const PASSWORD_RE = /^[0-9a-fA-F]{64}$/;

/** Non-secret fields `identityToMeta` writes into `account.meta`, copied through `check`.
 * The license key (`walletKey`) and refresh token are NOT here — they go into the encrypted
 * secret. */
const SE_META_KEYS = ['source', 'deviceFingerprint', 'tenant', 'containerId', 'deviceUdid', 'openvpnCa', 'credsAt'] as const;

export interface HmaSePlatformDeps {
  store: SeCatalogStore;
  net: SeFetch;
  now?: () => number;
  /** Reads an account's license key back from the encrypted secret store (it is never in
   * `account.meta`). Without it the provider cannot mint a token, so targets come back empty. */
  loadWalletKey?: (account: Account) => string | undefined;
  /** Reads the account's stored elysium refresh token (encrypted secret), so a restart renews
   * the token like the app instead of re-associating the license. */
  loadRefreshToken?: (account: Account) => string | undefined;
  /** Stores a new refresh token in the account's encrypted secret (each renew spends the old). */
  saveRefreshToken?: (account: Account, refreshToken: string) => void;
  /** The license now binds a different device (the old one was removed from the license):
   * store these replacement credentials + identity for the account. */
  onCredentialsReplaced?: (account: Account, update: { secret: AccountSecret; meta: Record<string, string> }) => void;
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
  const now = () => (se?.now ?? Date.now)();
  const minters = new Map<string, TokenMinter>();

  /** The license re-associated to a new device (the stored one was removed from it): fetch
   * the new device's OpenVPN credentials with the token that came back and hand the account
   * its replacement secret + identity. */
  async function replaceDevice(account: Account, identity: DeviceIdentity, walletKey: string, minted: SeDeviceToken): Promise<void> {
    if (!se?.onCredentialsReplaced) return;
    const tenant = tenantOfUdid(minted.deviceUdid) ?? identity.tenant;
    const creds = await fetchDeviceCredentials({ deviceUdid: minted.deviceUdid, tenantId: tenant, token: minted.accessToken }, se.net);
    const next: DeviceIdentity = {
      ...identity,
      tenant,
      deviceUdid: minted.deviceUdid,
      openvpnCaCertificate: creds.openvpnCaCertificate,
      credentialsAt: now(),
    };
    se.onCredentialsReplaced(account, {
      secret: { kind: 'userpass', username: creds.deviceUdid, password: creds.devicePassword, walletKey, refreshToken: minted.refreshToken },
      meta: { ...identityToMeta(next), licenseHint: licenseHint(walletKey) },
    });
  }

  function minterFor(account: Account, identity: DeviceIdentity, walletKey: string): TokenMinter {
    let m = minters.get(identity.deviceUdid);
    if (!m) {
      const minter = createTokenMinter(identity, walletKey, se!.net, {
        now: se?.now,
        refreshToken: se?.loadRefreshToken?.(account),
        onRefreshToken: (token) => se?.saveRefreshToken?.(account, token),
        onDeviceChanged: (minted) => {
          minters.set(minted.deviceUdid, minter);
          void replaceDevice(account, identity, walletKey, minted).catch(() => undefined);
        },
      });
      m = minter;
      minters.set(identity.deviceUdid, m);
    }
    return m;
  }

  /** An account's device identity (from meta) plus its license key (from the encrypted
   * secret). Returns undefined if either is missing, so callers degrade to "no device". */
  function deviceOf(account: Account): { identity: DeviceIdentity; minter: TokenMinter; walletKey: string } | undefined {
    const identity = identityFromMeta(account.meta);
    const walletKey = se?.loadWalletKey?.(account);
    if (!identity || !walletKey || !se) return undefined;
    return { identity, minter: minterFor(account, identity, walletKey), walletKey };
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
        // No minter is seeded here: the account does not exist yet, so a rotated refresh
        // token could not be saved. The first `deviceOf` builds one from the stored secret.
        return {
          input: {
            ...identityToMeta(dev.identity),
            udid: dev.username,
            password: dev.password,
            walletKey: licenseKey,
            refreshToken: dev.refreshToken,
          },
        };
      } catch (err) {
        return { reasonKey: seErrorKey(err) };
      }
    },

    check(input: Record<string, string>): CheckResult & { secret?: AccountSecret; meta?: Record<string, string> } {
      const udid = input.udid ?? '';
      const password = input.password ?? '';
      const walletKey = input.walletKey ?? '';
      const refreshToken = input.refreshToken ?? '';

      if (!UDID_RE.test(udid)) return { ok: false, reasonKey: 'hma.check.invalidUdid' };
      if (!PASSWORD_RE.test(password)) return { ok: false, reasonKey: 'hma.check.invalidPassword' };

      const meta: Record<string, string> = { udid };
      if (input.source === 'se-platform') {
        for (const k of SE_META_KEYS) if (input[k]) meta[k] = input[k];
        if (walletKey) meta.licenseHint = licenseHint(walletKey); // masked, non-secret, for the UI
      }
      return {
        ok: true,
        label: `device …${udid.slice(-6)}`,
        // The license key and refresh token go into the encrypted secret, never into
        // `meta` / state.json.
        secret: {
          kind: 'userpass',
          username: udid,
          password,
          ...(walletKey ? { walletKey } : {}),
          ...(refreshToken ? { refreshToken } : {}),
        },
        meta,
      };
    },

    async targets(account: Account): Promise<Target[]> {
      const device = deviceOf(account);
      if (!device || !se) return [];
      const geos = await se.store.geos({ tenant: device.identity.tenant }).catch(() => []);
      // Show the FULL location list the HMA app shows — every active geos city, whether or
      // not discover has cached a gateway for it yet. Undiscovered cities come back with an
      // empty `servers`; they stay selectable (HMA is a dynamic provider) and get their
      // gateways discovered on Add / Change IP, like the app discovers on Connect.
      // `servers` carries whatever IPs are cached.
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
      const device = deviceOf(account);
      if (!device || !se) return;
      await se.store
        .refreshOne({ minter: device.minter, tenant: device.identity.tenant }, locationKeyOf(locationKey))
        .catch(() => undefined);
    },

    /** The user's "Load locations": re-fetch the location list now. Gateways are still
     * discovered per location on demand — never a sweep of every country. */
    async refreshAll(account: Account): Promise<void> {
      const device = deviceOf(account);
      if (!device || !se) return;
      await se.store.geos({ tenant: device.identity.tenant }, { force: true }).catch(() => undefined);
    },

    /** New OpenVPN password + CA from passage (the app does this every 7 days). Note: this
     * ROTATES the device password shared by every port of the account. */
    async refreshCredentials(account: Account) {
      const device = deviceOf(account);
      if (!device || !se) return undefined;
      const { identity, minter, walletKey } = device;
      try {
        const creds = await withToken(minter, (token) =>
          fetchDeviceCredentials({ deviceUdid: identity.deviceUdid, tenantId: identity.tenant, token }, se.net),
        );
        const refreshed: DeviceIdentity = { ...identity, openvpnCaCertificate: creds.openvpnCaCertificate, credentialsAt: now() };
        const refreshToken = minter.refreshToken();
        return {
          // Keep the license key (and refresh token) in the refreshed secret so the account
          // stays mintable.
          secret: {
            kind: 'userpass' as const,
            username: creds.deviceUdid,
            password: creds.devicePassword,
            walletKey,
            ...(refreshToken ? { refreshToken } : {}),
          },
          meta: { ...identityToMeta(refreshed), licenseHint: licenseHint(walletKey) },
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
