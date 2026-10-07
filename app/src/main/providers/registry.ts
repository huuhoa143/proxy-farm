import type { Provider, ProviderId } from './types';

const providers = new Map<ProviderId, Provider>();

/** Register (or replace) a provider. */
export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: ProviderId): Provider | undefined {
  return providers.get(id);
}

export function allProviders(): Provider[] {
  return Array.from(providers.values());
}

/** Test-only: clear the registry between unit tests. Not part of the public surface. */
export function resetRegistryForTest(): void {
  providers.clear();
}
