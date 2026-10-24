/**
 * Entry point for the controller module: registers every built-in provider.
 * Call `registerAllProviders(opts)` once at app startup, then use
 * `getProvider`/`allProviders` from `./registry` everywhere else.
 */
import path from 'node:path';
import type { Account, AccountSecret } from './types';
import { registerProvider } from './registry';
import { createHmaProvider } from './hma';
import { createSeCatalogStore } from './hma/se-platform/catalog-store';
import { defaultSeFetch } from './hma/se-platform/net';
import { zoogvpnProvider } from './zoogvpn';
import { createSurfsharkProvider } from './surfshark';
import { createNordvpnProvider } from './nordvpn';
import { createExpressvpnProvider } from './expressvpn';
import { fileProvider } from './file';

export interface RegisterAllProvidersOptions {
  /**
   * Where Surfshark's 12h cluster cache lives — required, no cwd default
   * (see surfshark/index.ts). The controller should pass something durable,
   * e.g. `path.join(app.getPath('userData'), 'cache', 'surfshark-clusters.json')`.
   * The discovered server pools are kept beside it (`surfshark-pools.json`).
   */
  surfsharkCachePath: string;
  /**
   * Where NordVPN's 12h server-list cache lives (spec §5.5). Defaults to
   * `nordvpn-servers.json` in the same folder as `surfsharkCachePath`.
   */
  nordvpnCachePath?: string;
  /**
   * Where ExpressVPN's discovered server pools live (spec §5.6). Defaults to
   * `expressvpn-pools.json` in the same folder as `surfsharkCachePath`.
   */
  expressvpnPoolPath?: string;
  /** Where HMA's se-platform geos/discover caches live; defaults beside `surfsharkCachePath`. */
  hmaSePlatformDir?: string;
  /** Called when the HMA se-platform catalog gained fresh servers (controller re-emits
   * `targetsChanged` so the UI re-reads locations). */
  onTargetsChanged?: () => void;
  /** IPs live HMA ports currently hold; the se-platform catalog never stale-evicts these. */
  hmaHeldIps?: () => ReadonlySet<string>;
  /** Reads an HMA account's license key from the encrypted secret store (it is never in
   * `account.meta`); the provider needs it to mint se-platform tokens. */
  hmaLoadWalletKey?: (account: Account) => string | undefined;
  /** Read/store an HMA account's single-use elysium refresh token in its encrypted secret. */
  hmaLoadRefreshToken?: (account: Account) => string | undefined;
  hmaSaveRefreshToken?: (account: Account, refreshToken: string) => void;
  /** The HMA license now binds a different device: store its replacement secret + meta. */
  hmaOnCredentialsReplaced?: (account: Account, update: { secret: AccountSecret; meta: Record<string, string> }) => void;
}

export function registerAllProviders(opts: RegisterAllProvidersOptions): void {
  const seDir = opts.hmaSePlatformDir ?? path.dirname(opts.surfsharkCachePath);
  registerProvider(
    createHmaProvider({
      sePlatform: {
        net: defaultSeFetch,
        store: createSeCatalogStore({
          geosPath: path.join(seDir, 'hma-geos.json'),
          catalogPath: path.join(seDir, 'hma-se-catalog.json'),
          net: defaultSeFetch,
          onChange: opts.onTargetsChanged,
          heldIps: opts.hmaHeldIps,
        }),
        loadWalletKey: opts.hmaLoadWalletKey,
        loadRefreshToken: opts.hmaLoadRefreshToken,
        saveRefreshToken: opts.hmaSaveRefreshToken,
        onCredentialsReplaced: opts.hmaOnCredentialsReplaced,
      },
    }),
  );
  registerProvider(zoogvpnProvider);
  registerProvider(createSurfsharkProvider({ cachePath: opts.surfsharkCachePath }));
  registerProvider(
    createNordvpnProvider({
      cachePath: opts.nordvpnCachePath ?? path.join(path.dirname(opts.surfsharkCachePath), 'nordvpn-servers.json'),
    }),
  );
  registerProvider(
    createExpressvpnProvider({
      poolPath: opts.expressvpnPoolPath ?? path.join(path.dirname(opts.surfsharkCachePath), 'expressvpn-pools.json'),
    }),
  );
  registerProvider(fileProvider);
}

export { registerProvider, getProvider, allProviders } from './registry';
export * from './types';
