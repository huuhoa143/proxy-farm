import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
 * Administrators and the users who enabled it can read. The task runs at boot, every
 * 5 minutes and on demand: those users may start it (its security descriptor allows that),
 * so the app asks for a fresh copy at startup and before connecting, with no prompt, and
 * waits for that run to finish (`hma\last-run`). No Proxy Farm code stays running with
 * privileges, and the exposure equals macOS, where HMA's file is world-readable (spec §7
 * "accepted risk"). Once no recorded Proxy Farm executable has existed for a day
 * (uninstalled), the task removes itself and the copy.
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
/** `<start, Unix ms> <ok|none|untrusted|error>`, rewritten by every run of the task. */
export function hmaLastRunPath(programData?: string): string {
  return path.win32.join(hmaMirrorDir(programData), 'last-run');
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

/**
 * A PowerShell single-quoted string literal. PowerShell also ends such a string at the
 * typographic quotes ‘ ’ ‚ ‛, so every variant is doubled, not just the ASCII one.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** A local drive path (`C:\...`); never a UNC path or a drive-relative one. SYSTEM must not
 * probe a path a standard user could point at a network location. One pattern for both
 * sides: the app checks it here, the task (as SYSTEM) with .NET's `-cmatch`. */
const LOCAL_PATH_PATTERN = String.raw`^[A-Za-z]:\\(?!\\)`;
const LOCAL_PATH_RE = new RegExp(LOCAL_PATH_PATTERN);
export function isLocalPath(p: string): boolean {
  return LOCAL_PATH_RE.test(p);
}

/** How long no recorded Proxy Farm executable may exist before the task removes itself:
 * long enough to ride out an update that replaces the files, or a drive that is briefly
 * absent. */
export const UNINSTALL_GRACE_MS = 24 * 60 * 60_000;

/** The setup exits with these; 1223 comes from the elevation (ERROR_CANCELLED). */
const EXIT_NO_CREDENTIALS = 2;
const EXIT_UNSUPPORTED_LOCATION = 4;
const UAC_CANCELLED = 1223;

/**
 * Shared by the setup and the task, so both judge Proxy Farm's folders the same way:
 * `Test-OurDir` holds only for a real directory (not a reparse point) owned by SYSTEM or
 * Administrators, with a protected ACL in which nobody else may write, delete or change
 * permissions — i.e. a folder only the setup could have made. `Write-Atomic` writes a fresh
 * file (CreateNew, after deleting a leftover temp file, so it never writes through a link)
 * and renames it over the target.
 */
export const PS_COMMON = `$owners = @('S-1-5-18', 'S-1-5-32-544')
$writeMask = [long][Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership' -bor 0x50000000
function Test-OurDir([string]$p) {
  $it = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if (-not $it -or -not $it.PSIsContainer) { return $false }
  if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $acl = Get-Acl -LiteralPath $p
  if ($owners -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
  if (-not $acl.AreAccessRulesProtected) { return $false }
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -eq 'Allow' -and $owners -notcontains $r.IdentityReference.Value -and ([long]$r.FileSystemRights -band $writeMask) -ne 0) { return $false }
  }
  return $true
}
function Write-Atomic([string]$path, [byte[]]$bytes) {
  $tmp = "$path.tmp"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $path -Force
}`;

/** Drops comment lines, blank lines and indentation: both scripts travel inside command
 * lines (the task action, the elevation) that Windows caps at 32,767 characters. */
export function compactPowerShell(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n');
}

/**
 * The script the task runs as SYSTEM. It is embedded in the task action itself
 * (`-EncodedCommand`), never written to a file a user could later tamper with. It:
 * - unregisters itself when `ProxyFarm\` is gone (HMA support was removed), and does
 *   nothing at all unless `ProxyFarm\` and `hma\` pass `Test-OurDir` — anyone may create
 *   folders under `%ProgramData%`, so a recreated folder or a junction must never receive
 *   (or lose) a file written as SYSTEM;
 * - removes itself and `ProxyFarm\` once none of the executables in `ProxyFarm\apps` (one per
 *   install that enabled it) has existed for `UNINSTALL_GRACE_MS`;
 * - checks that every folder from `Privax` down to HMA's `auth` file is owned by SYSTEM,
 *   Administrators or TrustedInstaller and is not a reparse point, so a user cannot make it
 *   copy some other SYSTEM-readable file or follow a link out; then copies the file only
 *   when it changed, or removes the copy when HMA has none (signed out);
 * - always ends by writing `hma\last-run`, which the app and the setup wait for.
 */
export function buildSyncScript(): string {
  return `# Proxy Farm - HMA support. Installed by Proxy Farm; runs as SYSTEM.
# Keeps a copy of HMA VPN's device credentials that Proxy Farm can read.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$root = Join-Path $env:ProgramData 'ProxyFarm'
$dir = Join-Path $root 'hma'
$dst = Join-Path $dir 'auth'
$hmaDir = Join-Path $env:ProgramData 'Privax\\HMA VPN\\HmaProVpn'
$src = Join-Path $hmaDir 'auth'
$localPath = ${psQuote(LOCAL_PATH_PATTERN)}
${PS_COMMON}
# TrustedInstaller, SYSTEM and Administrators are the only owners HMA's folders may have.
$trusted = $owners + 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
function Test-Trusted([string]$p) {
  $it = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if (-not $it) { return $false }
  if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  return $trusted -contains (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value
}
function Remove-Self {
  Unregister-ScheduledTask -TaskPath ${psQuote(HMA_TASK_FOLDER)} -TaskName ${psQuote(HMA_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue
  try { $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect(); $svc.GetFolder('\\').DeleteFolder(${psQuote(HMA_TASK_FOLDER.replace(/\\/g, ''))}, 0) } catch { }
}
function Remove-Copy { if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force } }
function Sync-Copy {
  foreach ($p in @((Join-Path $env:ProgramData 'Privax'), (Join-Path $env:ProgramData 'Privax\\HMA VPN'), $hmaDir, $src)) {
    if (-not (Test-Path -LiteralPath $p)) { Remove-Copy; return 'none' }
    # Signed out, or HMA's folder is not trustworthy: do not keep a stale copy around.
    if (-not (Test-Trusted $p)) { Remove-Copy; return 'untrusted' }
  }
  $bytes = [IO.File]::ReadAllBytes($src)
  if ((Test-Path -LiteralPath $dst -PathType Leaf) -and
      ([Convert]::ToBase64String([IO.File]::ReadAllBytes($dst)) -eq [Convert]::ToBase64String($bytes))) { return 'ok' }
  Write-Atomic $dst $bytes
  return 'ok'
}
if (-not (Test-Path -LiteralPath $root)) { Remove-Self; exit 0 }
if (-not (Test-OurDir $root) -or -not (Test-OurDir $dir)) { exit 0 }
# From here on every run reports, even one that fails, so nobody waits for it in vain.
try {
  $installed = $false
  $apps = Join-Path $root 'apps'
  if (Test-Path -LiteralPath $apps -PathType Leaf) {
    foreach ($a in [IO.File]::ReadAllLines($apps)) {
      if ($a -cmatch $localPath -and (Test-Path -LiteralPath $a -PathType Leaf)) { $installed = $true; break }
    }
  }
  $since = Join-Path $root 'missing-since'
  if ($installed) {
    if (Test-Path -LiteralPath $since) { Remove-Item -LiteralPath $since -Force }
  } else {
    # Proxy Farm looks uninstalled: remove HMA support only once that has lasted, so an update
    # that replaces the files, or a drive that is briefly absent, does not switch it off.
    [long]$first = 0
    if (-not ((Test-Path -LiteralPath $since -PathType Leaf) -and [long]::TryParse([IO.File]::ReadAllText($since).Trim(), [ref]$first))) {
      $first = $started
      Write-Atomic $since ([Text.Encoding]::ASCII.GetBytes([string]$started))
    }
    if ($started - $first -ge ${UNINSTALL_GRACE_MS}) {
      Remove-Self
      cmd.exe /d /c rd /s /q "$root" | Out-Null
      exit 0
    }
  }
  $result = Sync-Copy
} catch { $result = 'error' }
Write-Atomic (Join-Path $dir 'last-run') ([Text.Encoding]::ASCII.GetBytes("$started $result"))
`;
}

/** PowerShell's `-EncodedCommand`: base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The elevated setup (run once per user, after the UAC prompt). It:
 * - keeps `%ProgramData%\ProxyFarm` and `…\hma` when they pass `Test-OurDir`, and otherwise
 *   deletes whatever is there (anyone may create folders under `%ProgramData%`) and creates
 *   them with their final security descriptor in one step — owned by Administrators, a
 *   protected ACL that grants the users who enabled HMA support read only — so there is no
 *   moment in which a user could create a file inside;
 * - adds this install's executable to `ProxyFarm\apps`, which every install that enabled
 *   it shares (the task stays while any of them exists);
 * - registers the task with the sync script embedded in its action and a security descriptor
 *   that lets those users start it; the script is never written to disk;
 * - runs the task and waits for that run's `last-run`: exits 0 with a copy, 2 when HMA has
 *   no credentials, 3 when HMA's folder is untrusted or the run ended without reporting;
 * - before changing anything, exits 4 when the executable is not on a fixed local drive.
 */
export function buildSetupScript(opts: { userSid: string; appExe: string }): string {
  if (!SID_RE.test(opts.userSid)) throw new Error(`hma-windows: not a SID: ${opts.userSid}`);
  if (!isLocalPath(opts.appExe)) throw new Error(`hma-windows: appExe must be a local path: ${opts.appExe}`);
  const syncEncoded = encodePowerShell(compactPowerShell(buildSyncScript()));
  const powershell = `$env:SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'`;
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sid = ${psQuote(opts.userSid)}
$app = ${psQuote(opts.appExe)}
$localPath = ${psQuote(LOCAL_PATH_PATTERN)}
$root = Join-Path $env:ProgramData 'ProxyFarm'
$dir = Join-Path $root 'hma'
${PS_COMMON}
$users = New-Object System.Collections.Generic.List[string]
$users.Add($sid)
# The task (as SYSTEM) checks this path for as long as HMA support is on, so it must be on a
# fixed local volume every session sees: not removable, not a network drive.
if ([IO.DriveInfo]::new($app.Substring(0, 1)).DriveType -ne 'Fixed') { exit ${EXIT_UNSUPPORTED_LOCATION} }

function Remove-IfNotOurs([string]$path) {
  # Returns $true if, afterwards, $path does NOT exist (so the caller creates it fresh).
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $true }
  if (Test-OurDir $path) { return $false }
  # Not ours (or a link): remove without following links (rd never traverses junctions).
  if ($item.PSIsContainer) { cmd.exe /d /c rd /s /q "$path" | Out-Null } else { Remove-Item -LiteralPath $path -Force }
  if (Test-Path -LiteralPath $path) { throw "cannot replace $path" }
  return $true
}

function New-OurDir([string]$path, [bool]$userInherits) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($s in $owners) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$s, 'FullControl', $inherit, 'None', 'Allow')))
  }
  $flags = if ($userInherits) { $inherit } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($u in $users) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$u, 'ReadAndExecute', $flags, 'None', 'Allow')))
  }
  # Created with its final security descriptor in one step. If someone recreated the path
  # since the check, CreateDirectory returns theirs and Test-OurDir below refuses it.
  if (Remove-IfNotOurs $path) { $null = [IO.Directory]::CreateDirectory($path, $acl) } else { Set-Acl -LiteralPath $path -AclObject $acl }
  if (-not (Test-OurDir $path)) { throw "$path is not an Administrators-owned folder only they may write" }
}

# Keep the users who enabled HMA support before, if the existing hma folder is ours.
if (Test-OurDir $dir) {
  foreach ($rule in (Get-Acl -LiteralPath $dir).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
    $v = $rule.IdentityReference.Value
    if ($rule.AccessControlType -eq 'Allow' -and $owners -notcontains $v -and -not $users.Contains($v)) { $users.Add($v) }
  }
}
New-OurDir $root $false
New-OurDir $dir $true

# Every install that enabled HMA support; the task stays while any of them exists.
$appsFile = Join-Path $root 'apps'
$apps = New-Object System.Collections.Generic.List[string]
$apps.Add($app)
if (Test-Path -LiteralPath $appsFile -PathType Leaf) {
  foreach ($a in [IO.File]::ReadAllLines($appsFile)) {
    if ($a -cmatch $localPath -and -not ($apps -contains $a)) { $apps.Add($a) }
  }
}
Write-Atomic $appsFile ([Text.Encoding]::UTF8.GetBytes(($apps -join [Environment]::NewLine)))
$since = Join-Path $root 'missing-since'
if (Test-Path -LiteralPath $since) { Remove-Item -LiteralPath $since -Force }

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
# Queue (not ignore) a run requested while one is in progress, so whoever asked for a run
# gets one that started after the request.
$def.Settings.MultipleInstances = 1
$def.Principal.UserId = 'S-1-5-18'
$def.Principal.LogonType = 5
$boot = $def.Triggers.Create(8)
$every = $def.Triggers.Create(1)
$every.StartBoundary = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
$every.Repetition.Interval = 'PT5M'
# The sync script is embedded in the action (-EncodedCommand), not a file on disk.
$action = $def.Actions.Create(0)
$action.Path = ${powershell}
$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${syncEncoded}'
$sddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)' + (($users | ForEach-Object { "(A;;GRGX;;;$_)" }) -join '')
$task = $folder.RegisterTaskDefinition(${psQuote(HMA_TASK_NAME)}, $def, 6, 'SYSTEM', $null, 5, $sddl)

# Run it once and wait for that run (up to its 2-minute limit) to report.
$requested = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# LastRunTime has a resolution of one second: compare with the request's whole second.
$now = Get-Date
$requestedAt = $now.AddTicks(-($now.Ticks % [TimeSpan]::TicksPerSecond))
$null = $task.Run($null)
$lastRun = Join-Path $dir 'last-run'
$deadline = [DateTime]::UtcNow.AddSeconds(125)
$result = ''
$ended = $false
while (-not $result -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  try { $parts = [IO.File]::ReadAllText($lastRun).Trim() -split ' ' } catch { $parts = @() }
  [long]$at = 0
  if ($parts.Count -eq 2 -and [long]::TryParse($parts[0], [ref]$at) -and $at -ge $requested) { $result = $parts[1] }
  if (-not $result) {
    # Read once more after the run ended, then stop: it ended without reporting.
    if ($ended) { break }
    $t = $folder.GetTask(${psQuote(HMA_TASK_NAME)})
    $ended = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $requested -gt 2000 -and $t.State -eq 3 -and $t.LastRunTime -ge $requestedAt
  }
}
if ($result -eq 'ok') { exit 0 }
if ($result -eq 'none') { exit ${EXIT_NO_CREDENTIALS} }
exit 3
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

/** `hma\last-run`: when the run started (Unix ms) and how it ended. */
export function parseLastRun(text: string): { started: number; result: string } | undefined {
  const m = text.trim().match(/^(\d+) ([a-z]+)$/);
  return m ? { started: Number(m[1]), result: m[2] } : undefined;
}

const POWERSHELL = () => system32('WindowsPowerShell\\v1.0\\powershell.exe');

/** Windows' command-line limit (CreateProcess), which both PowerShell launches must fit. */
export const MAX_COMMAND_LINE = 32_767;

/**
 * The unelevated `-Command` that shows the UAC prompt and returns the elevated setup's exit
 * code. It starts the elevated PowerShell through .NET (`ShellExecute` with the `runas`
 * verb) rather than `Start-Process -Verb RunAs`, whose error carries no Win32 code: only a
 * dismissed prompt (ERROR_CANCELLED) exits 1223, any other failure to elevate exits 1. The
 * setup travels in memory as UTF-8 base64, never through a user-writable file. One encoding
 * layer only: -EncodedCommand is UTF-16 base64, and nesting it inside another one outgrows
 * the command-line limit.
 */
export function buildElevationCommand(setupScript: string): string {
  const b64 = Buffer.from(compactPowerShell(setupScript), 'utf8').toString('base64');
  // Inside the elevated -Command: run the decoded script as a script block.
  const elevated = `& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))))`;
  return (
    `$psi = New-Object Diagnostics.ProcessStartInfo -ArgumentList ${psQuote(POWERSHELL())}; ` +
    `$psi.Verb = 'runas'; $psi.UseShellExecute = $true; $psi.WindowStyle = 'Hidden'; ` +
    `$psi.Arguments = ${psQuote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command ${elevated}`)}; ` +
    `try { $p = [Diagnostics.Process]::Start($psi) } catch { ` +
    `$e = $_.Exception; while ($e -and -not ($e -is [ComponentModel.Win32Exception])) { $e = $e.InnerException }; ` +
    `if ($e -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }; exit 1 }; ` +
    `$p.WaitForExit(); exit $p.ExitCode`
  );
}

/** The task runs at least every 5 minutes; a `last-run` older than three runs means it no
 * longer reports (removed, disabled, or its folder no longer passes `Test-OurDir`). */
export const LAST_RUN_STALE_MS = 15 * 60_000;

/** Whether `last-run` shows the task keeping the copy up to date. */
export function isLastRunFresh(text: string, now = Date.now()): boolean {
  const last = parseLastRun(text);
  // Either way: a clock set back must not keep a task that stopped looking fresh.
  return last !== undefined && Math.abs(now - last.started) <= LAST_RUN_STALE_MS;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'no-credentials' | 'unsupported-location' | 'failed' };

export interface HmaWindowsSupport {
  /** Runs the elevated setup (one UAC prompt). */
  enable(): Promise<EnableResult>;
  /** Has the task make a fresh copy and waits (bounded) until that run finished; returns at
   * once when HMA support is not enabled. Never prompts, never throws. */
  refresh(): Promise<void>;
}

export interface HmaWindowsSupportOptions {
  /** The executable the task checks to tell whether Proxy Farm is still installed. */
  appExe?: string;
  /** Resolves `subst` drives to their target and mapped network drives to UNC (tests). */
  realpath?: (p: string) => string;
  runFile?: RunFile;
  /** The copy's folder and its `last-run` stamp (tests). */
  mirrorDir?: string;
  lastRunPath?: string;
  /** How long refresh() waits for the run it requested (a cold SYSTEM PowerShell is ~1 s),
   * and how long when the task has stopped reporting (`LAST_RUN_STALE_MS`). */
  refreshTimeoutMs?: number;
  staleRefreshTimeoutMs?: number;
  refreshPollMs?: number;
}

export function createHmaWindowsSupport(opts: HmaWindowsSupportOptions = {}): HmaWindowsSupport {
  const runFile = opts.runFile ?? defaultRunFile;
  const appExe = opts.appExe ?? process.execPath;
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
  const mirrorDir = opts.mirrorDir ?? hmaMirrorDir();
  const lastRunPath = opts.lastRunPath ?? hmaLastRunPath();
  const refreshTimeoutMs = opts.refreshTimeoutMs ?? 20_000;
  const staleRefreshTimeoutMs = opts.staleRefreshTimeoutMs ?? 5_000;
  const refreshPollMs = opts.refreshPollMs ?? 100;

  return {
    async enable() {
      // The path SYSTEM will see: a `subst` drive resolves to its target, a mapped network
      // drive to its UNC path (both exist only in this user's logon session).
      let exe: string;
      try {
        exe = realpath(appExe);
      } catch {
        return { ok: false, reason: 'failed' };
      }
      // The task probes this path as SYSTEM; a non-local path (e.g. UNC) is refused so it
      // can never make SYSTEM authenticate to a remote host.
      if (!isLocalPath(exe)) return { ok: false, reason: 'unsupported-location' };
      const who = await runFile(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
      const userSid = parseWhoamiSid(who.stdout);
      if (!userSid) return { ok: false, reason: 'failed' };
      const outer = buildElevationCommand(buildSetupScript({ userSid, appExe: exe }));
      const { code } = await runFile(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-Command', outer]);
      if (code === 0) return { ok: true };
      if (code === UAC_CANCELLED) return { ok: false, reason: 'cancelled' };
      if (code === EXIT_NO_CREDENTIALS) return { ok: false, reason: 'no-credentials' };
      if (code === EXIT_UNSUPPORTED_LOCATION) return { ok: false, reason: 'unsupported-location' };
      return { ok: false, reason: 'failed' };
    },

    async refresh() {
      // No copy folder: HMA support was never enabled for this machine, so there is no task.
      if (!existsSync(mirrorDir)) return;
      // A task that stopped reporting (see LAST_RUN_STALE_MS) is not waited for long: the
      // read that follows then asks the user to enable HMA support again.
      const before = await readFile(lastRunPath, 'utf8').catch(() => '');
      const timeoutMs = isLastRunFresh(before) ? refreshTimeoutMs : Math.min(refreshTimeoutMs, staleRefreshTimeoutMs);
      // `schtasks /run` returns once the run is started, not finished: wait for a last-run
      // stamped at or after the request (the task queues a run asked for during another).
      const requested = Date.now();
      const run = await runFile(system32('schtasks.exe'), ['/run', '/tn', `${HMA_TASK_FOLDER}${HMA_TASK_NAME}`]).catch(() => undefined);
      if (run?.code !== 0) return;
      while (Date.now() - requested < timeoutMs) {
        // The run removed HMA support (Proxy Farm uninstalled long enough): nothing will report.
        if (!existsSync(mirrorDir)) return;
        const last = parseLastRun(await readFile(lastRunPath, 'utf8').catch(() => ''));
        if (last && last.started >= requested) return;
        await new Promise((r) => setTimeout(r, refreshPollMs));
      }
    },
  };
}
