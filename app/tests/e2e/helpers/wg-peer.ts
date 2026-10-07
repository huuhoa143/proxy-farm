import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WgPeer {
  /** Client-side WireGuard .conf to import into Proxy Farm. */
  conf: string;
  stop(): void;
}

function keypair(singbox: string): { priv: string; pub: string } {
  const out = execFileSync(singbox, ['generate', 'wg-keypair'], { encoding: 'utf8' });
  return { priv: /PrivateKey:\s*(\S+)/.exec(out)![1], pub: /PublicKey:\s*(\S+)/.exec(out)![1] };
}

/**
 * A LOCAL WireGuard "VPN server": a second sing-box running a wireguard endpoint on
 * 127.0.0.1:<udpPort> whose route goes straight out via a direct outbound. Keys are
 * freshly generated per run (never committed). The binary is copied under a different
 * name so `pgrep sing-box` checks only ever see Proxy Farm's own engines.
 */
export function startLocalWgPeer(singbox: string, workDir: string, udpPort: number): WgPeer {
  mkdirSync(workDir, { recursive: true });
  const server = keypair(singbox);
  const client = keypair(singbox);
  const config = {
    log: { level: 'warn' },
    endpoints: [
      {
        type: 'wireguard',
        tag: 'wg-srv',
        system: false,
        address: ['10.99.0.1/24'],
        private_key: server.priv,
        listen_port: udpPort,
        peers: [{ public_key: client.pub, allowed_ips: ['10.99.0.2/32'] }],
      },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
  };
  // One copy per peer: overwriting a RUNNING signed binary in place invalidates its code
  // signature pages and macOS SIGKILLs the first peer.
  const bin = path.join(workDir, `wg-peer-server-${udpPort}`);
  copyFileSync(singbox, bin);
  const cfgPath = path.join(workDir, `peer-${udpPort}.json`);
  writeFileSync(cfgPath, JSON.stringify(config));
  const proc: ChildProcess = spawn(bin, ['run', '-c', cfgPath], { stdio: 'ignore' });
  const conf = [
    '[Interface]',
    `PrivateKey = ${client.priv}`,
    'Address = 10.99.0.2/32',
    '',
    '[Peer]',
    `PublicKey = ${server.pub}`,
    'AllowedIPs = 0.0.0.0/0',
    `Endpoint = 127.0.0.1:${udpPort}`,
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
  return { conf, stop: () => void proc.kill('SIGTERM') };
}
