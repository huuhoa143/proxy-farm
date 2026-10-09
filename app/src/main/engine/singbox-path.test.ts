import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { singboxPath, assertSingboxVersion, hostPlatformKey } from './singbox-path';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REAL_BIN = singboxPath({ appRoot: APP_ROOT, isPackaged: false });

/** `sing-box version` output as the real binary prints it, with the given version and tags. */
const versionOutput = (version: string, tags: string) =>
  `sing-box version ${version}

Environment: go1.26.8 ${hostPlatformKey(process.platform, process.arch).replace('-', '/')}
Tags: ${tags}
Revision: deadbeef
CGO: enabled
`;

describe('singboxPath', () => {
  it('maps darwin-arm64 to the dev resources path', () => {
    const p = singboxPath({ platform: 'darwin', arch: 'arm64', isPackaged: false, appRoot: APP_ROOT });
    expect(p).toBe(path.join(APP_ROOT, 'resources', 'sing-box', 'darwin-arm64', 'sing-box'));
  });

  it('maps darwin-x64 to the darwin-amd64 asset directory', () => {
    const p = singboxPath({ platform: 'darwin', arch: 'x64', isPackaged: false, appRoot: APP_ROOT });
    expect(p).toBe(path.join(APP_ROOT, 'resources', 'sing-box', 'darwin-amd64', 'sing-box'));
  });

  it('maps win32-x64 to the windows-amd64 asset with .exe', () => {
    const p = singboxPath({ platform: 'win32', arch: 'x64', isPackaged: false, appRoot: APP_ROOT });
    expect(p).toBe(path.join(APP_ROOT, 'resources', 'sing-box', 'windows-amd64', 'sing-box.exe'));
  });

  it('throws for an unsupported platform/arch pair', () => {
    expect(() => singboxPath({ platform: 'linux', arch: 'x64', isPackaged: false })).toThrow(/Unsupported platform/);
  });

  it('resolves under process.resourcesPath when packaged', () => {
    const p = singboxPath({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      resourcesPath: '/Applications/Proxy Farm.app/Contents/Resources',
    });
    expect(p).toBe(path.join('/Applications/Proxy Farm.app/Contents/Resources', 'sing-box', 'darwin-arm64', 'sing-box'));
  });

  it('throws when packaged but no resourcesPath is available', () => {
    expect(() => singboxPath({ platform: 'darwin', arch: 'arm64', isPackaged: true, resourcesPath: undefined })).toThrow(
      /resourcesPath/,
    );
  });

  it('defaults isPackaged to false outside Electron (this test runs under plain Node)', () => {
    const p = singboxPath({ platform: 'darwin', arch: 'arm64', appRoot: APP_ROOT });
    expect(p).toBe(path.join(APP_ROOT, 'resources', 'sing-box', 'darwin-arm64', 'sing-box'));
  });
});

describe('assertSingboxVersion', () => {
  it('resolves for the real pinned 1.14.2 binary with required tags', async () => {
    await expect(assertSingboxVersion(REAL_BIN)).resolves.toBeUndefined();
  });

  it('rejects when the binary reports a different version', async () => {
    const run = async () => versionOutput('1.13.0', 'with_gvisor,with_wireguard,with_openvpn');
    await expect(assertSingboxVersion('fake-sing-box', run)).rejects.toThrow(/1\.14\.2/);
  });

  it('rejects when a required tag is missing', async () => {
    const run = async () => versionOutput('1.14.2', 'with_gvisor,with_openvpn,with_quic');
    await expect(assertSingboxVersion('fake-sing-box', run)).rejects.toThrow(/with_wireguard/);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(assertSingboxVersion(path.join(APP_ROOT, 'resources', 'sing-box', 'nope', 'sing-box'))).rejects.toThrow();
  });
});
