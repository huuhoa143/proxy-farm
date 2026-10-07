/**
 * Entry point for the controller module: registers every built-in provider.
 * Call `registerAllProviders()` once at app startup, then use
 * `getProvider`/`allProviders` from `./registry` everywhere else.
 */
import { registerProvider } from './registry';
import { hmaProvider } from './hma';
import { zoogvpnProvider } from './zoogvpn';
import { surfsharkProvider } from './surfshark';
import { fileProvider } from './file';

export function registerAllProviders(): void {
  registerProvider(hmaProvider);
  registerProvider(zoogvpnProvider);
  registerProvider(surfsharkProvider);
  registerProvider(fileProvider);
}

export { registerProvider, getProvider, allProviders } from './registry';
export * from './types';
