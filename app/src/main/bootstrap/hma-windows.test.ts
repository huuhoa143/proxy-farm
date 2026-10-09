import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildElevationCommand,
  buildSetupScript,
  buildSyncScript,
  compactPowerShell,
  createHmaWindowsSupport,
  encodePowerShell,
  hmaAuthPath,
  hmaLastRunPath,
  hmaMirrorPath,
  isLocalPath,
  MAX_COMMAND_LINE,
  parseLastRun,
  parseWhoamiSid,
  PS_COMMON,
  psQuote,
  type RunFile,
  UNINSTALL_GRACE_MS,
} from './hma-windows';

const SID = 'S-1-5-21-3764570052-1490414795-2259877278-1001';

describe('HMA support on Windows (spec §7)', () => {
  it('derives every path from ProgramData', () => {
    expect(hmaAuthPath('D:\\PD')).toBe('D:\\PD\\Privax\\HMA VPN\\HmaProVpn\\auth');
    expect(hmaMirrorPath('D:\\PD')).toBe('D:\\PD\\ProxyFarm\\hma\\auth');
    expect(hmaLastRunPath('D:\\PD')).toBe('D:\\PD\\ProxyFarm\\hma\\last-run');
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

  it('quotes the app path as a PowerShell literal in the setup', () => {
    const script = buildSetupScript({ userSid: SID, appExe: "C:\\Users\\O'Brien\\Proxy Farm.exe" });
    expect(script).toContain("$app = 'C:\\Users\\O''Brien\\Proxy Farm.exe'");
  });

  it('accepts only a local drive app path, with one pattern shared by the app and the task', () => {
    expect(isLocalPath('C:\\Users\\me\\AppData\\Local\\Programs\\proxy-farm\\Proxy Farm.exe')).toBe(true);
    expect(isLocalPath('D:\\Apps\\proxy-farm\\Proxy Farm.exe')).toBe(true);
    expect(isLocalPath('\\\\server\\share\\Proxy Farm.exe')).toBe(false);
    expect(isLocalPath('\\\\?\\C:\\x.exe')).toBe(false);
    expect(isLocalPath('C:\\\\x.exe')).toBe(false);
    expect(isLocalPath('relative\\x.exe')).toBe(false);
    expect(() => buildSetupScript({ userSid: SID, appExe: '\\\\evil\\share\\x.exe' })).toThrow(/local path/);
    // The task and the setup check recorded paths with the very same .NET pattern.
    const pattern = "$localPath = '^[A-Za-z]:\\\\(?!\\\\)'";
    expect(buildSyncScript()).toContain(pattern);
    expect(buildSyncScript()).toContain('-cmatch $localPath');
    expect(buildSetupScript({ userSid: SID, appExe: 'C:\\pf.exe' })).toContain(pattern);
  });

  it("the sync script verifies HMA's folders are trusted before copying", () => {
    const sync = buildSyncScript();
    expect(sync).toContain('function Test-Trusted');
    // TrustedInstaller, SYSTEM and Administrators are the only accepted owners.
    expect(sync).toContain('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
    expect(sync).toContain('ReparsePoint');
  });

  it('the sync script touches nothing unless both Proxy Farm folders are exactly as the setup left them', () => {
    const sync = buildSyncScript();
    expect(sync).toContain("if (-not (Test-OurDir $root) -or -not (Test-OurDir $dir)) { exit 0 }");
    // Owner, protected ACL and nobody else allowed to write: all part of the test.
    expect(sync).toContain('AreAccessRulesProtected');
    expect(sync).toContain('$writeMask');
    // Files are written fresh (never through a planted link), then renamed into place.
    expect(sync).toContain('[IO.FileMode]::CreateNew');
  });

  it('the sync script removes itself only after no recorded executable existed for the grace period', () => {
    const sync = buildSyncScript();
    expect(sync).toContain("$apps = Join-Path $root 'apps'");
    expect(sync).toContain(`-ge ${UNINSTALL_GRACE_MS}`);
    expect(UNINSTALL_GRACE_MS).toBe(24 * 60 * 60_000);
    // Without its folder, HMA support was removed: unregister, nothing else.
    expect(sync).toContain('if (-not (Test-Path -LiteralPath $root)) { Remove-Self; exit 0 }');
  });

  it('every run of the sync script ends by stamping last-run with its start and outcome', () => {
    const sync = buildSyncScript();
    expect(sync).toContain("Write-Atomic (Join-Path $dir 'last-run') ([Text.Encoding]::ASCII.GetBytes(\"$started $result\"))");
    expect(parseLastRun('1791503985071 ok\r\n')).toEqual({ started: 1791503985071, result: 'ok' });
    expect(parseLastRun('1791503985071')).toBeUndefined();
    expect(parseLastRun('')).toBeUndefined();
  });

  it('compacts a script without changing its statements', () => {
    expect(compactPowerShell("# note\n  $a = 1  \r\n\n    # indented note\nif ($a) {\n  'x'  # trailing stays\n}\n")).toBe(
      "$a = 1\nif ($a) {\n'x'  # trailing stays\n}",
    );
  });

  it('the setup embeds the sync script in the task action, grants the users read + run only, and never writes a script file', () => {
    const setup = buildSetupScript({ userSid: SID, appExe: 'C:\\pf.exe' });
    const encoded = setup.match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/)?.[1] ?? '';
    expect(encoded).toBe(encodePowerShell(compactPowerShell(buildSyncScript())));
    expect(setup).toContain(`$sid = '${SID}'`);
    expect(setup).toContain("'ReadAndExecute'");
    expect(setup).toContain('(A;;GRGX;;;$_)');
    expect(setup).not.toContain('hma-sync.ps1');
    // Queue a run requested during another, so a requester always gets a run after its request.
    expect(setup).toContain('$def.Settings.MultipleInstances = 1');
  });

  it('the setup creates its folders with their final security descriptor in one step and refuses anything else', () => {
    const setup = buildSetupScript({ userSid: SID, appExe: 'C:\\pf.exe' });
    expect(setup).toContain('[IO.Directory]::CreateDirectory($path, $acl)');
    expect(setup).toContain('if (-not (Test-OurDir $path)) { throw');
    // Every install that enabled HMA support is recorded; earlier ones are kept.
    expect(setup).toContain("$appsFile = Join-Path $root 'apps'");
    expect(setup).toContain('-not ($apps -contains $a)');
  });

  it("the setup waits for its own run's last-run and reports the outcome", () => {
    const setup = buildSetupScript({ userSid: SID, appExe: 'C:\\pf.exe' });
    expect(setup).toContain('$at -ge $requested');
    expect(setup).toContain("if ($result -eq 'ok') { exit 0 }");
    expect(setup).toContain("if ($result -eq 'none') { exit 2 }");
    expect(setup).toContain('exit 3');
  });

  it('the elevation command carries the setup intact, tells a dismissed prompt from other failures, and fits the Windows command line', () => {
    const setup = buildSetupScript({ userSid: SID, appExe: `C:\\Users\\${'a'.repeat(200)}\\AppData\\Local\\Programs\\proxy-farm\\Proxy Farm.exe` });
    const command = buildElevationCommand(setup);
    expect(command).toContain("$psi.Verb = 'runas'");
    expect(command).toContain('$e.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }');
    const b64 = command.match(/FromBase64String\(''([^']+)''\)/)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(compactPowerShell(setup));
    // powershell.exe path + flags + the command, with room to spare.
    expect(command.length + 200).toBeLessThan(MAX_COMMAND_LINE);
  });

  // The folder test and the atomic write, run by the real Windows PowerShell (no elevation
  // needed; the Administrators-owned cases run only when the test process is elevated).
  it.runIf(process.platform === 'win32')('Test-OurDir and Write-Atomic behave as specified', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pf-ps-'));
    try {
      const script = `${PS_COMMON}
$ErrorActionPreference = 'Stop'
$t = ${psQuote(tmp)}
$out = [ordered]@{}
$plain = Join-Path $t 'plain'; $null = New-Item -ItemType Directory $plain
$out.inherited = Test-OurDir $plain
$out.missing = Test-OurDir (Join-Path $t 'nope')
$f = Join-Path $t 'f'
Write-Atomic $f ([Text.Encoding]::ASCII.GetBytes('one'))
[IO.File]::WriteAllText("$f.tmp", 'leftover')
Write-Atomic $f ([Text.Encoding]::ASCII.GetBytes('two'))
$out.written = [IO.File]::ReadAllText($f)
$out.tmpLeft = Test-Path "$f.tmp"
$out.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($out.elevated) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  function New-Acl([string]$userRights) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($s in $owners) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$s, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))) }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, $userRights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    return ,$acl
  }
  $ours = Join-Path $t 'ours'; $null = [IO.Directory]::CreateDirectory($ours, (New-Acl 'ReadAndExecute'))
  $out.ours = Test-OurDir $ours
  $writable = Join-Path $t 'writable'; $null = [IO.Directory]::CreateDirectory($writable, (New-Acl 'Modify'))
  $out.userMayWrite = Test-OurDir $writable
  $link = Join-Path $t 'link'; cmd.exe /d /c mklink /J "$link" "$ours" | Out-Null
  $out.junction = Test-OurDir $link
  cmd.exe /d /c rd "$link" | Out-Null
}
$out | ConvertTo-Json -Compress`;
      const stdout = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const r = JSON.parse(stdout.trim());
      expect(r).toMatchObject({ inherited: false, missing: false, written: 'two', tmpLeft: false });
      if (r.elevated) expect(r).toMatchObject({ ours: true, userMayWrite: false, junction: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

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
      expect(calls[1][1][3]).toContain("$psi.Verb = 'runas'");
    });

    it.each([
      [1223, 'cancelled'],
      [2, 'no-credentials'],
      [3, 'failed'],
      [1, 'failed'],
    ])('maps exit code %i to %s', async (code, reason) => {
      expect(await support(code).hma.enable()).toEqual({ ok: false, reason });
    });

    it('fails without prompting when the SID cannot be read', async () => {
      const calls: string[] = [];
      const hma = createHmaWindowsSupport({ appExe: 'C:\\pf.exe', runFile: async (file) => (calls.push(file), { code: 1, stdout: '' }) });
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

  describe('refresh()', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'pf-hma-'));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    const mirrorDir = () => join(tmp, 'hma');
    const lastRunPath = () => join(tmp, 'hma', 'last-run');
    const enableFolder = () => mkdirSync(mirrorDir());
    const stamp = (started: number, result = 'ok') => writeFileSync(lastRunPath(), `${started} ${result}`);
    const make = (runFile: RunFile, refreshTimeoutMs = 2000) =>
      createHmaWindowsSupport({ mirrorDir: mirrorDir(), lastRunPath: lastRunPath(), runFile, refreshTimeoutMs, refreshPollMs: 5 });

    it('does nothing when HMA support was never enabled (no copy folder)', async () => {
      const calls: string[] = [];
      await make(async (f) => (calls.push(f), { code: 0, stdout: '' })).refresh();
      expect(calls).toHaveLength(0);
    });

    it('starts the task and returns only once a run started after the request has reported', async () => {
      enableFolder();
      stamp(Date.now() - 60_000); // an earlier run's stamp must not count
      const calls: Array<[string, string[]]> = [];
      let reportedAt = 0;
      const hma = make(async (file, args) => {
        calls.push([file, args]);
        const started = Date.now();
        setTimeout(() => {
          stamp(started);
          reportedAt = Date.now();
        }, 60);
        return { code: 0, stdout: '' };
      });
      await hma.refresh();
      expect(reportedAt).toBeGreaterThan(0);
      expect(calls[0][0]).toMatch(/\\System32\\schtasks\.exe$/i);
      expect(calls[0][1]).toEqual(['/run', '/tn', '\\ProxyFarm\\HMA credentials']);
    });

    it('returns at once when the task cannot be started, and never throws', async () => {
      enableFolder();
      const t0 = Date.now();
      await expect(make(async () => ({ code: 1, stdout: '' }), 5000).refresh()).resolves.toBeUndefined();
      await expect(
        make(async () => {
          throw new Error('schtasks missing');
        }, 5000).refresh(),
      ).resolves.toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it('gives up after the timeout when no run reports', async () => {
      enableFolder();
      const t0 = Date.now();
      await make(async () => ({ code: 0, stdout: '' }), 100).refresh();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    });
  });
});
