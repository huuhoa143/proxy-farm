/**
 * Entry point for the controller module: registers every built-in provider.
 * Call `registerAllProviders(opts)` once at app startup, then use
 * `getProvider`/`allProviders` from `./registry` everywhere else.
 */
import { registerProvider } from './registry';
import { hmaProvider } from './hma';
import { zoogvpnProvider } from './zoogvpn';
import { createSurfsharkProvider } from './surfshark';
import { fileProvider } from './file';

export interface RegisterAllProvidersOptions {
  /**
   * Where Surfshark's 12h cluster cache lives — required, no cwd default
   * (see surfshark/index.ts). The controller should pass something durable,
   * e.g. `path.join(app.getPath('userData'), 'cache', 'surfshark-clusters.json')`.
   * The discovered server pools are kept beside it (`surfshark-pools.json`).
   */
  surfsharkCachePath: string;
}

export function registerAllProviders(opts: RegisterAllProvidersOptions): void {
  registerProvider(hmaProvider);
  registerProvider(zoogvpnProvider);
  registerProvider(createSurfsharkProvider({ cachePath: opts.surfsharkCachePath }));
  registerProvider(fileProvider);
}

export { registerProvider, getProvider, allProviders } from './registry';
export * from './types';
