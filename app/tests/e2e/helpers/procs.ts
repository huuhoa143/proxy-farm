import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';

/** Every live sing-box engine: pid → executable path. Matches on the process's own
 * executable (`ps -o comm`), not its command line, so shells that merely mention
 * "sing-box" never count. */
export function singboxProcesses(): Array<{ pid: number; cmd: string }> {
  if (process.platform === 'win32') {
    // `tasklist` matches the image name exactly (the local WireGuard peers run under
    // another name); CSV rows look like "sing-box.exe","1234",…
    return execFileSync('tasklist', ['/fo', 'csv', '/nh', '/fi', 'IMAGENAME eq sing-box.exe'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.match(/^"([^"]+)","(\d+)"/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ pid: Number(m[2]), cmd: m[1] }));
  }
  return execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\/sing-box$/.test(line))
    .map((line) => ({ pid: Number(line.split(/\s+/)[0]), cmd: line.slice(line.search(/\s/) + 1) }));
}

/** curl through a port's SOCKS5 inbound with proxy auth; returns the HTTP status. */
export function curlThrough(port: number, user: string, pass: string, url: string): string {
  try {
    return execFileSync(
      'curl',
      ['-sS', '-o', devNull, '-w', '%{http_code}', '--max-time', '20', '-x', `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${port}`, url],
      { encoding: 'utf8' },
    ).trim();
  } catch (err) {
    return `ERR ${(err as Error).message.split('\n')[0]}`;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
