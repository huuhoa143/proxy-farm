/**
 * Entry point for the controller module: registers every built-in provider.
 * Call `registerAllProviders(opts)` once at app startup, then use
 * `getProvider`/`allProviders` from `./registry` everywhere else.
 */
import path from 'node:path';
import { registerProvider } from './registry';
import { hmaProvider } from './hma';
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
}

export function registerAllProviders(opts: RegisterAllProvidersOptions): void {
  registerProvider(hmaProvider);
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
