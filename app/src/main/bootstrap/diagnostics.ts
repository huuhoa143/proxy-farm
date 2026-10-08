import type { Account, Diagnostics, PortRow, PortState, ProviderId } from '../../shared/contracts';

/** The environment half of `Diagnostics`, supplied by the composition root. */
export type DiagnosticsEnv = Omit<Diagnostics, 'providers'>;

/**
 * Builds the "Copy diagnostics" report. Redaction is by construction: from accounts and
 * ports only the provider id and the port state's `kind` are read, never a label,
 * `meta`, `secretRef`, server, IP or proxy port, so nothing identifying can leak into a
 * public bug report no matter what those records hold.
 */
export function collectDiagnostics(
  data: { accounts: readonly Account[]; ports: readonly PortRow[] },
  env: DiagnosticsEnv,
  providerIds: readonly ProviderId[],
): Diagnostics {
  const providers = providerIds.map((id) => {
    const ports = data.ports.filter((p) => p.providerId === id);
    const portStates: Partial<Record<PortState['kind'], number>> = {};
    for (const p of ports) portStates[p.state.kind] = (portStates[p.state.kind] ?? 0) + 1;
    return { id, accounts: data.accounts.filter((a) => a.providerId === id).length, ports: ports.length, portStates };
  });
  return {
    appVersion: env.appVersion,
    os: { platform: env.os.platform, release: env.os.release, arch: env.os.arch },
    versions: { electron: env.versions.electron, chrome: env.versions.chrome, node: env.versions.node },
    singBox: env.singBox,
    providers,
  };
}
