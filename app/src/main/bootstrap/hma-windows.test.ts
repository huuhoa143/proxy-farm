import { describe, expect, it } from 'vitest';
import {
  buildElevationCommand,
  buildSetupScript,
  buildSyncScript,
  createHmaWindowsSupport,
  hmaAuthPath,
  hmaMirrorPath,
  isLocalPath,
  MAX_COMMAND_LINE,
  parseWhoamiSid,
  psQuote,
  type RunFile,
} from './hma-windows';

const SID = 'S-1-5-21-3764570052-1490414795-2259877278-1001';

describe('HMA support on Windows (spec §7)', () => {
  it('derives every path from ProgramData', () => {
    expect(hmaAuthPath('D:\\PD')).toBe('D:\\PD\\Privax\\HMA VPN\\HmaProVpn\\auth');
    expect(hmaMirrorPath('D:\\PD')).toBe('D:\\PD\\ProxyFarm\\hma\\auth');
  });

  it("reads the user's SID from whoami's CSV output (local and Entra ID accounts)", () => {
    expect(parseWhoamiSid(`"desktop-q7td65i\\admin","${SID}"\r\n`)).toBe(SID);
    expect(parseWhoamiSid('"azuread\\me","S-1-12-1-111-222-333-444"\r\n')).toBe('S-1-12-1-111-222-333-444');
    expect(parseWhoamiSid('whoami: extra operand')).toBeUndefined();
  });

  it('refuses to build the setup for anything but a SID', () => {
    expect(() => buildSetupScript({ userSid: "S-1-5-21-1'; rm -r C:\\", appExe: 'C:\\a.exe' })).toThrow(/not a SID/);
  });

  it('doubles every quote PowerShell ends a single-quoted string at', () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(psQuote('C:\\Users\\O\u2019Brien\u2018x\u201Ay\u201Bz')).toBe("'C:\\Users\\O\u2019\u2019Brien\u2018\u2018x\u201A\u201Ay\u201B\u201Bz'");
  });

  it('quotes the app path as a PowerShell literal in the task script', () => {
    const script = buildSyncScript("C:\\Users\\O'Brien\\Proxy Farm.exe");
    expect(script).toContain("$app = 'C:\\Users\\O''Brien\\Proxy Farm.exe'");
  });

  it('accepts only a local fixed-drive app path', () => {
    expect(isLocalPath('C:\\Users\\me\\AppData\\Local\\Programs\\proxy-farm\\Proxy Farm.exe')).toBe(true);
    expect(isLocalPath('\\\\server\\share\\Proxy Farm.exe')).toBe(false);
    expect(isLocalPath('\\\\?\\C:\\x.exe')).toBe(false);
    expect(isLocalPath('relative\\x.exe')).toBe(false);
    expect(() => buildSyncScript('\\\\evil\\share\\x.exe')).toThrow(/local path/);
  });

  it('the sync script verifies HMA\'s folders are trusted before copying, and refuses a non-local app path', () => {
    const sync = buildSyncScript('C:\\pf.exe');
    expect(sync).toContain('function Test-Trusted');
    // TrustedInstaller, SYSTEM and Administrators are the only accepted owners.
    expect(sync).toContain('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
    expect(sync).toContain('ReparsePoint');
    // The runtime self-removal guard accepts any local drive (not UNC), so a per-user
    // install on D: is not mistaken for an uninstall. Non-regex to dodge backslash escaping.
    expect(sync).toContain("$app[1] -eq ':' -and $app[2] -eq '\\'");
    const onD = buildSyncScript('D:\\Apps\\proxy-farm\\Proxy Farm.exe');
    expect(onD).toContain("$app = 'D:\\Apps\\proxy-farm\\Proxy Farm.exe'");
  });

  it('the setup embeds the sync script in the task action, grants the user read + run only, and never writes a script file', () => {
    const setup = buildSetupScript({ userSid: SID, appExe: 'C:\\pf.exe' });
    const encoded = setup.match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/)?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(buildSyncScript('C:\\pf.exe'));
    expect(setup).toContain(`$sid = '${SID}'`);
    expect(setup).toContain("'ReadAndExecute'");
    expect(setup).toContain('(A;;GRGX;;;$_)');
    // No script file on disk any more.
    expect(setup).not.toContain('hma-sync.ps1');
    // Every created folder ends up an Administrators-owned real directory or the setup throws.
    expect(setup).toContain('not owned by Administrators');
    expect(setup).toContain('is a reparse point');
  });

  it('the elevation command carries the setup intact and fits the Windows command line', () => {
    const setup = buildSetupScript({ userSid: SID, appExe: `C:\\Users\\${'a'.repeat(200)}\\AppData\\Local\\Programs\\proxy-farm\\Proxy Farm.exe` });
    const command = buildElevationCommand(setup);
    expect(command).toContain('-Verb RunAs');
    const b64 = command.match(/FromBase64String\(''([^']+)''\)/)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(setup);
    // powershell.exe path + flags + the command, with room to spare.
    expect(command.length + 200).toBeLessThan(MAX_COMMAND_LINE);
  });

  describe('enable()', () => {
    function support(outerCode: number) {
      const calls: Array<[string, string[]]> = [];
      const runFile: RunFile = async (file, args) => {
        calls.push([file, args]);
        if (/whoami\.exe$/i.test(file)) return { code: 0, stdout: `"pc\\me","${SID}"` };
        return { code: outerCode, stdout: '' };
      };
      return { calls, hma: createHmaWindowsSupport({ appExe: 'C:\\pf.exe', runFile }) };
    }

    it('runs whoami and the elevated setup by absolute System32 paths', async () => {
      const { calls, hma } = support(0);
      expect(await hma.enable()).toEqual({ ok: true });
      expect(calls.map(([file]) => file)).toEqual([
        expect.stringMatching(/\\System32\\whoami\.exe$/i),
        expect.stringMatching(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i),
      ]);
      expect(calls[1][1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
      expect(calls[1][1][3]).toContain('-Verb RunAs');
    });

    it.each([
      [1223, 'cancelled'],
      [2, 'no-credentials'],
      [1, 'failed'],
    ])('maps exit code %i to %s', async (code, reason) => {
      expect(await support(code).hma.enable()).toEqual({ ok: false, reason });
    });

    it('fails without prompting when the SID cannot be read', async () => {
      const calls: string[] = [];
      const hma = createHmaWindowsSupport({ runFile: async (file) => (calls.push(file), { code: 1, stdout: '' }) });
      expect(await hma.enable()).toEqual({ ok: false, reason: 'failed' });
      expect(calls).toHaveLength(1);
    });

    it('refuses a non-local app path without running anything', async () => {
      const calls: string[] = [];
      const hma = createHmaWindowsSupport({ appExe: '\\\\srv\\share\\Proxy Farm.exe', runFile: async (f) => (calls.push(f), { code: 0, stdout: '' }) });
      expect(await hma.enable()).toEqual({ ok: false, reason: 'failed' });
      expect(calls).toHaveLength(0);
    });
  });

  it('refresh() starts the task and never throws', async () => {
    const calls: Array<[string, string[]]> = [];
    const hma = createHmaWindowsSupport({
      runFile: async (file, args) => {
        calls.push([file, args]);
        throw new Error('schtasks missing');
      },
    });
    await expect(hma.refresh()).resolves.toBeUndefined();
    expect(calls[0][1]).toEqual(['/run', '/tn', '\\ProxyFarm\\HMA credentials']);
  });
});
