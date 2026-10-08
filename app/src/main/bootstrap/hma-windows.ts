import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * HMA support on Windows (spec §7, revised after the Windows spike of 2026-10-09).
 *
 * HMA keeps its OpenVPN device credentials in `%ProgramData%\Privax\HMA VPN\HmaProVpn\auth`
 * (line 1 the username `U1.<device>.hma101.<hex>`, line 2 the 64-hex password). The folder
 * is readable by SYSTEM and Administrators only, and HMA rotates the pair about weekly.
 * The spike verified that this pair authenticates with the same provider config as the
 * macOS `tokenCoreSE.json` credentials (bundled Sectigo R46 CA, `openvpn.gen-vpn.com`).
 *
 * Instead of a resident LocalSystem service with a named pipe, "Enable HMA support" (one
 * UAC prompt) registers a SYSTEM scheduled task that copies that file into
 * `%ProgramData%\ProxyFarm\hma\auth`, a folder owned by Administrators that only SYSTEM,
 * Administrators and the enabling user can read. The task runs at boot, every 5 minutes
 * and on demand: the user may start it (its security descriptor allows that), so the app
 * asks for a fresh copy at startup and before connecting, with no prompt. No Proxy Farm
 * code stays running with privileges, and the exposure equals macOS, where HMA's file is
 * world-readable (spec §7 "accepted risk"). When Proxy Farm's executable is gone
 * (uninstalled), the next run removes the task and the copy.
 */

export const HMA_TASK_FOLDER = '\\ProxyFarm\\';
export const HMA_TASK_NAME = 'HMA credentials';

export function proxyFarmDataDir(programData = process.env.ProgramData ?? 'C:\\ProgramData'): string {
  return path.win32.join(programData, 'ProxyFarm');
}
/** The user-readable copy the task maintains. */
export function hmaMirrorDir(programData?: string): string {
  return path.win32.join(proxyFarmDataDir(programData), 'hma');
}
export function hmaMirrorPath(programData?: string): string {
  return path.win32.join(hmaMirrorDir(programData), 'auth');
}
/** HMA's own credentials file (admin-only). */
export function hmaAuthPath(programData = process.env.ProgramData ?? 'C:\\ProgramData'): string {
  return path.win32.join(programData, 'Privax', 'HMA VPN', 'HmaProVpn', 'auth');
}

/** System tools by absolute path: never whatever an inherited PATH finds first. */
export function system32(exe: string): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
}

const SID_RE = /^S-1-\d+(-\d+)+$/;

/** A PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The script the task runs as SYSTEM. Copies HMA's `auth` only when it changed (so the
 * app's file watcher sees real changes only), via a temp file and a rename so a reader
 * never sees half a file, and removes the copy when HMA has none (signed out).
 */
export function buildSyncScript(appExe: string): string {
  return `# Proxy Farm - HMA support. Installed by Proxy Farm; runs as SYSTEM.
# Keeps a copy of HMA VPN's device credentials that Proxy Farm can read.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:ProgramData 'ProxyFarm'
$dir = Join-Path $root 'hma'
$dst = Join-Path $dir 'auth'
$src = Join-Path $env:ProgramData 'Privax\\HMA VPN\\HmaProVpn\\auth'
$app = ${psQuote(appExe)}
if (-not (Test-Path -LiteralPath $app -PathType Leaf)) {
  # Proxy Farm was uninstalled: remove this task and the copy.
  Unregister-ScheduledTask -TaskPath ${psQuote(HMA_TASK_FOLDER)} -TaskName ${psQuote(HMA_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue
  try { $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect(); $svc.GetFolder('\\').DeleteFolder(${psQuote(HMA_TASK_FOLDER.replace(/\\/g, ''))}, 0) } catch { }
  cmd.exe /d /c rd /s /q "$root" | Out-Null
  exit 0
}
if (-not (Test-Path -LiteralPath $dir -PathType Container)) { exit 0 }
if (Test-Path -LiteralPath $src -PathType Leaf) {
  $bytes = [IO.File]::ReadAllBytes($src)
  if ((Test-Path -LiteralPath $dst -PathType Leaf) -and
      ([Convert]::ToBase64String([IO.File]::ReadAllBytes($dst)) -eq [Convert]::ToBase64String($bytes))) { exit 0 }
  $tmp = "$dst.tmp"
  [IO.File]::WriteAllBytes($tmp, $bytes)
  Move-Item -LiteralPath $tmp -Destination $dst -Force
} elseif (Test-Path -LiteralPath $dst) {
  Remove-Item -LiteralPath $dst -Force
}
`;
}

/**
 * The elevated setup (run once, after the UAC prompt). It (re)creates
 * `%ProgramData%\ProxyFarm` with an Administrators-owned, protected ACL (a folder that
 * existed with any other owner is deleted first, since anyone may create folders in
 * ProgramData), writes the sync script there, and registers the task with a security
 * descriptor that lets the enabling user start it. Users who enabled it before keep
 * their access. Exits 0 once the copy exists, 2 when HMA has no credentials yet.
 */
export function buildSetupScript(opts: { userSid: string; appExe: string }): string {
  if (!SID_RE.test(opts.userSid)) throw new Error(`hma-windows: not a SID: ${opts.userSid}`);
  const sync = buildSyncScript(opts.appExe);
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sid = ${psQuote(opts.userSid)}
$root = Join-Path $env:ProgramData 'ProxyFarm'
$dir = Join-Path $root 'hma'
$trusted = @('S-1-5-18', 'S-1-5-32-544')
$users = New-Object System.Collections.Generic.List[string]
$users.Add($sid)

function Get-TrustedDir([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  $isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  $owner = if ($item.PSIsContainer -and -not $isLink) { (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value } else { '' }
  if ($trusted -contains $owner) { return $item }
  # Not ours: remove it without following links (rd never traverses junctions).
  if ($item.PSIsContainer) { cmd.exe /d /c rd /s /q "$path" | Out-Null } else { Remove-Item -LiteralPath $path -Force }
  if (Test-Path -LiteralPath $path) { throw "cannot replace $path" }
  return $null
}

function Set-DirAcl([string]$path, [bool]$userInherits) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $none = [Security.AccessControl.InheritanceFlags]::None
  foreach ($s in $trusted) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$s, 'FullControl', $inherit, 'None', 'Allow')))
  }
  $flags = if ($userInherits) { $inherit } else { $none }
  foreach ($u in $users) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$u, 'ReadAndExecute', $flags, 'None', 'Allow')))
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}

$rootItem = Get-TrustedDir $root
if ($rootItem) {
  $dirItem = Get-TrustedDir $dir
  if ($dirItem) {
    # Keep the users who enabled HMA support before.
    foreach ($rule in (Get-Acl -LiteralPath $dir).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
      $v = $rule.IdentityReference.Value
      if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $v -and -not $users.Contains($v)) { $users.Add($v) }
    }
  }
}
if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
Set-DirAcl $root $false
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
Set-DirAcl $dir $true

$script = Join-Path $root 'hma-sync.ps1'
if (Test-Path -LiteralPath $script) { Remove-Item -LiteralPath $script -Force }
$syncB64 = ${psQuote(Buffer.from(sync, 'utf8').toString('base64'))}
[IO.File]::WriteAllText($script, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($syncB64)), (New-Object Text.UTF8Encoding($true)))
# A file's owner may always rewrite its ACL, and a new file can be owned by the elevated
# user rather than Administrators: a script SYSTEM runs must not belong to the user.
$scriptAcl = Get-Acl -LiteralPath $script
$scriptAcl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
Set-Acl -LiteralPath $script -AclObject $scriptAcl

$svc = New-Object -ComObject 'Schedule.Service'
$svc.Connect()
try { $folder = $svc.GetFolder(${psQuote(HMA_TASK_FOLDER.replace(/\\$/, ''))}) } catch { $folder = $svc.GetFolder('\\').CreateFolder(${psQuote(HMA_TASK_FOLDER.replace(/\\/g, ''))}) }
$def = $svc.NewTask(0)
$def.RegistrationInfo.Author = 'Proxy Farm'
$def.RegistrationInfo.Description = 'Proxy Farm: keeps a copy of HMA VPN device credentials that Proxy Farm can read (HMA support).'
$def.Settings.Enabled = $true
$def.Settings.Hidden = $true
$def.Settings.StartWhenAvailable = $true
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries = $false
$def.Settings.ExecutionTimeLimit = 'PT2M'
$def.Settings.MultipleInstances = 2
$def.Principal.UserId = 'S-1-5-18'
$def.Principal.LogonType = 5
$boot = $def.Triggers.Create(8)
$every = $def.Triggers.Create(1)
$every.StartBoundary = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
$every.Repetition.Interval = 'PT5M'
$action = $def.Actions.Create(0)
$action.Path = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
$sddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)' + (($users | ForEach-Object { "(A;;GRGX;;;$_)" }) -join '')
$task = $folder.RegisterTaskDefinition(${psQuote(HMA_TASK_NAME)}, $def, 6, 'SYSTEM', $null, 5, $sddl)
$null = $task.Run($null)

$auth = Join-Path $dir 'auth'
for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath $auth); $i++) { Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath $auth) { exit 0 } else { exit 2 }
`;
}

export type RunFile = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultRunFile: RunFile = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5 * 60_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** `whoami /user /fo csv /nh` → `"host\user","S-1-5-21-…"`. */
export function parseWhoamiSid(stdout: string): string | undefined {
  const sid = stdout.match(/"(S-1-[\d-]+)"/)?.[1];
  return sid && SID_RE.test(sid) ? sid : undefined;
}

/** The outer exit code when the user dismisses the UAC prompt (ERROR_CANCELLED). */
const UAC_CANCELLED = 1223;

const POWERSHELL = () => system32('WindowsPowerShell\\v1.0\\powershell.exe');

/** Windows' command-line limit (CreateProcess), which both PowerShell launches must fit. */
export const MAX_COMMAND_LINE = 32_767;

/**
 * The unelevated `-Command` that shows the UAC prompt (Start-Process -Verb RunAs) and
 * returns the elevated setup's exit code (1223 when the prompt is dismissed). The setup
 * travels in memory as UTF-8 base64, never through a user-writable file. One encoding
 * layer only: -EncodedCommand is UTF-16 base64, and nesting it inside another one
 * outgrows the command-line limit.
 */
export function buildElevationCommand(setupScript: string): string {
  const b64 = Buffer.from(setupScript, 'utf8').toString('base64');
  // Inside the elevated -Command: run the decoded script as a script block.
  const elevated = `& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))))`;
  return (
    `try { $p = Start-Process -FilePath ${psQuote(POWERSHELL())} -Verb RunAs -WindowStyle Hidden -Wait -PassThru ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',${psQuote(elevated)} } ` +
    `catch { exit ${UAC_CANCELLED} }; exit $p.ExitCode`
  );
}

export type EnableResult = { ok: true } | { ok: false; reason: 'cancelled' | 'no-credentials' | 'failed' };

export interface HmaWindowsSupport {
  /** Runs the elevated setup (one UAC prompt). */
  enable(): Promise<EnableResult>;
  /** Asks the task for a fresh copy now; never prompts, never throws. */
  refresh(): Promise<void>;
}

export interface HmaWindowsSupportOptions {
  /** The executable the task checks to tell whether Proxy Farm is still installed. */
  appExe?: string;
  runFile?: RunFile;
}

export function createHmaWindowsSupport(opts: HmaWindowsSupportOptions = {}): HmaWindowsSupport {
  const runFile = opts.runFile ?? defaultRunFile;
  const appExe = opts.appExe ?? process.execPath;

  return {
    async enable() {
      const who = await runFile(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
      const userSid = parseWhoamiSid(who.stdout);
      if (!userSid) return { ok: false, reason: 'failed' };
      const outer = buildElevationCommand(buildSetupScript({ userSid, appExe }));
      const { code } = await runFile(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-Command', outer]);
      if (code === 0) return { ok: true };
      if (code === UAC_CANCELLED) return { ok: false, reason: 'cancelled' };
      if (code === 2) return { ok: false, reason: 'no-credentials' };
      return { ok: false, reason: 'failed' };
    },

    async refresh() {
      await runFile(system32('schtasks.exe'), ['/run', '/tn', `${HMA_TASK_FOLDER}${HMA_TASK_NAME}`]).catch(() => undefined);
    },
  };
}
