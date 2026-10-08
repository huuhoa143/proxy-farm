import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { buildSocksProxyUrl } from '../health/exit-ip';

/** spec §4.2/§4.3: speed.cloudflare.com is contacted ONLY when the user runs a speed test. */
export const SPEED_TEST_URL = 'https://speed.cloudflare.com/__down?bytes=10000000';

export interface SpeedTestOptions {
  url?: string;
  /** Hard cap on the whole download. @default 30_000 */
  timeoutMs?: number;
  auth?: { username: string; password: string };
}

/**
 * Downloads `url` through the port's own SOCKS5 inbound (with proxy auth) and reports
 * the throughput in megabits per second, measured from the first response byte so the
 * tunnel's connect/TLS time isn't counted as bandwidth. Rejects on a non-200 or timeout.
 */
export function measureDownloadMbps(proxyPort: number, opts: SpeedTestOptions = {}): Promise<number> {
  const url = opts.url ?? SPEED_TEST_URL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const agent = new SocksProxyAgent(buildSocksProxyUrl(proxyPort, opts.auth)) as unknown as https.Agent;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`speed test: HTTP ${res.statusCode}`));
        return;
      }
      let bytes = 0;
      let firstByteAt = 0;
      res.on('data', (chunk: Buffer) => {
        if (!firstByteAt) firstByteAt = Date.now();
        bytes += chunk.length;
      });
      res.on('end', () => {
        const seconds = Math.max((Date.now() - (firstByteAt || Date.now())) / 1000, 0.001);
        resolve(Math.round(((bytes * 8) / seconds / 1e6) * 10) / 10);
      });
      res.on('error', reject);
    });
    const hardTimer = setTimeout(() => req.destroy(new Error('speed test: timed out')), timeoutMs);
    req.on('close', () => clearTimeout(hardTimer));
    req.on('timeout', () => req.destroy(new Error('speed test: timed out')));
    req.on('error', reject);
  });
}
