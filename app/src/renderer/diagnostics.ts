import type { Diagnostics, PortState } from '../shared/contracts';

const STATE_ORDER: Array<PortState['kind']> = ['online', 'connecting', 'verifying', 'queued', 'retrying', 'failed', 'stopped'];

/**
 * The plain-text report "Copy diagnostics" puts on the clipboard, in English (it goes
 * into GitHub issues). Only the known fields of `Diagnostics` are read, field by field,
 * so even an object carrying extra properties cannot leak them into the report.
 */
export function formatDiagnostics(d: Diagnostics): string {
  const lines = [
    'Proxy Farm diagnostics',
    `App: ${d.appVersion}`,
    `OS: ${d.os.platform} ${d.os.release} (${d.os.arch})`,
    `Electron: ${d.versions.electron} | Chrome: ${d.versions.chrome} | Node: ${d.versions.node}`,
    `sing-box: ${d.singBox ?? 'unavailable (engine check failed)'}`,
    'Providers:',
  ];
  for (const p of d.providers) {
    const states = STATE_ORDER.filter((k) => (p.portStates[k] ?? 0) > 0).map((k) => `${k} ${p.portStates[k]}`);
    lines.push(`  ${p.id}: ${p.accounts} account(s), ${p.ports} port(s)${states.length ? ` (${states.join(', ')})` : ''}`);
  }
  return lines.join('\n');
}
