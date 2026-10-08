import { describe, expect, it } from 'vitest';
import {
  buildElevationCommand,
  buildSetupScript,
  buildSyncScript,
  createHmaWindowsSupport,
  hmaAuthPath,
  hmaMirrorPath,
  MAX_COMMAND_LINE,
  parseWhoamiSid,
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

  it('quotes the app path as a PowerShell literal in the task script', () => {
    const script = buildSyncScript("C:\\Users\\O'Brien\\Proxy Farm.exe");
    expect(script).toContain("$app = 'C:\\Users\\O''Brien\\Proxy Farm.exe'");
  });

  it('the setup embeds the task script, grants the user read + run only, and hands the script to Administrators', () => {
    const setup = buildSetupScript({ userSid: SID, appExe: 'C:\\pf.exe' });
    const embedded = setup.match(/\$syncB64 = '([^']+)'/)?.[1] ?? '';
    expect(Buffer.from(embedded, 'base64').toString('utf8')).toBe(buildSyncScript('C:\\pf.exe'));
    expect(setup).toContain(`$sid = '${SID}'`);
    expect(setup).toContain("'ReadAndExecute'");
    expect(setup).toContain('(A;;GRGX;;;$_)');
    expect(setup).toMatch(/\$scriptAcl\.SetOwner\(\[Security\.Principal\.SecurityIdentifier\]'S-1-5-32-544'\)/);
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
