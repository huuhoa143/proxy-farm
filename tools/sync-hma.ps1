<#
  Sync HMA into Proxy Farm — Windows.

  The HMA Windows app has no IKEv2 device certificate (that is a macOS-only thing). It
  logs in over OpenVPN with a username/password and a shared CA that live under
  %ProgramData%\...\HmaProVpn, readable only by Administrators. This reads them and drops
  a bundle in the farm inbox; the farm logs in with them, one account driving every
  location as a pool.

  Usage (double-click tools\sync-hma.bat, or run directly):
    sync-hma.ps1              sync the login once (fast; farm uses its built-in server list)
    sync-hma.ps1 -Full        also re-scan every location's current server IP (slow; cycles VPN)
    sync-hma.ps1 -Install     set up hands-off auto-sync (a scheduled task refreshes the
                              login into the farm every few hours and at logon) — one UAC
                              prompt now, then nothing to click again
    sync-hma.ps1 -Uninstall   remove the auto-sync task and its installed copy
  Reading the credentials needs admin, so a UAC prompt appears unless already elevated.

  -Inbox / -Port are set by the installer on the scheduled task so the elevated run uses
  values fixed at install time and never re-reads the user-writable repo (.env).
#>
param([switch]$Full, [switch]$Install, [switch]$Uninstall, [switch]$Quiet,
      [string]$Inbox, [string]$Port)
$ErrorActionPreference = 'Stop'
$TASK    = 'ProxyFarm-HMA-Sync'
$INSTDIR = Join-Path $env:ProgramFiles 'ProxyFarm'          # admin-only writable

function Pause-IfNeeded { if (-not $Quiet) { Write-Host; Read-Host 'Xong. Nhấn Enter để đóng' | Out-Null } }
function Fail($m) { Write-Host "[X] $m" -ForegroundColor Red; Pause-IfNeeded; exit 1 }

# ---- must be Administrator to read the credential files (and to register the task) ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Cần quyền admin — đang xin quyền (UAC)…"
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  if ($Full)      { $a += '-Full' }
  if ($Install)   { $a += '-Install' }
  if ($Uninstall) { $a += '-Uninstall' }
  Start-Process powershell -Verb RunAs -ArgumentList $a
  exit
}

# ---- uninstall mode ---------------------------------------------------------------
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TASK -Confirm:$false
    Write-Host "[OK] Đã gỡ tác vụ tự động đồng bộ ($TASK)." -ForegroundColor Green
  } else { Write-Host "Không có tác vụ tự động đồng bộ nào để gỡ." }
  if (Test-Path $INSTDIR) { Remove-Item $INSTDIR -Recurse -Force -ErrorAction SilentlyContinue }
  Pause-IfNeeded; exit 0
}

# ---- locate the HMA credential files ---------------------------------------------
$dirs = @(
  "$env:ProgramData\Privax\HMA VPN\HmaProVpn",
  "$env:ProgramData\HMA VPN\HmaProVpn",
  "$env:ProgramData\Privax\HMA! Pro VPN\HmaProVpn"
)
$hd = $dirs | Where-Object { Test-Path (Join-Path $_ 'auth') } | Select-Object -First 1
if (-not $hd) { Fail "Không tìm thấy đăng nhập HMA trên máy này.`n    Hãy cài app HMA VPN, đăng nhập và kết nối thử một lần, rồi chạy lại." }
$authLines = Get-Content (Join-Path $hd 'auth')
$user = ($authLines[0]).Trim(); $pass = ($authLines[1]).Trim()
$ca   = (Get-Content (Join-Path $hd 'ca.crt.pem') -Raw).Trim()
if (-not ($user -and $pass -and $ca)) { Fail "Đăng nhập HMA không đầy đủ (thiếu user/pass/ca)." }
Write-Host "[OK] Đã đọc đăng nhập HMA (user $($user.Substring(0,[Math]::Min(10,$user.Length)))…)."

# ---- resolve the inbox + port ----------------------------------------------------
# When the scheduled task runs us it passes -Inbox/-Port fixed at install time, so the
# elevated run never reads the user-writable repo .env. Interactive runs fall back to it.
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo '.env'
function FromEnv($key, $default) {
  if (Test-Path $envFile) { $m = Select-String -Path $envFile -Pattern "^$key=(.*)$" | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim().Trim('"') } }
  return $default
}
if (-not $Inbox) {
  $FARM = if ($env:FARM) { $env:FARM } else { FromEnv 'FARM' (Join-Path $env:USERPROFILE 'proxy-farm') }
  $Inbox = Join-Path $FARM 'inbox'
}
if (-not $Port) { $Port = if ($env:PORT) { $env:PORT } else { FromEnv 'PORT' '8090' } }
New-Item -ItemType Directory -Force $Inbox | Out-Null

# ---- build the bundle (credentials always; catalog only on -Full) ----------------
$bundle = [ordered]@{ hma_ovpn = $true; user = $user; pass = $pass; ca = $ca }
if ($Full) {
  Write-Host "[..] Dò lại máy chủ từng vị trí (sẽ ngắt VPN của bạn vài phút)…" -ForegroundColor Yellow
  try { $bundle.catalog = & (Join-Path $PSScriptRoot 'hma-enum-servers.ps1') }
  catch { Write-Host "[!] Dò máy chủ thất bại ($_). Vẫn gửi đăng nhập; farm dùng danh sách sẵn có." -ForegroundColor Yellow }
}
$out = Join-Path $Inbox 'hma-ovpn.json'
# UTF-8 without a BOM: a BOM makes the farm's json.loads choke on the first byte.
[IO.File]::WriteAllText($out, ($bundle | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
Write-Host "[OK] Đã ghi đăng nhập vào farm: $out"

# ---- nudge the farm to import right away (best-effort) ---------------------------
try {
  $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/provider/hma-sync" -Body '{}' -TimeoutSec 10
  if ($r.imported) { Write-Host "[OK] Farm đã nạp — $($r.status.locations) vị trí sẵn sàng." -ForegroundColor Green }
  else { Write-Host "      Farm sẽ tự nạp trong vòng 1 phút (hoặc bấm nút Sync trong giao diện)." }
} catch { Write-Host "      Chưa gọi được farm (có thể chưa chạy). Nó sẽ tự nạp khi khởi động." }

# ---- install mode: register the hands-off auto-sync task --------------------------
if ($Install) {
  # The task runs elevated and repeatedly, so it must NOT point at the user-writable repo
  # script (a non-admin could replace it and get it run as admin). Copy the script to an
  # admin-only location, lock its ACL, and point the task there with fixed arguments.
  New-Item -ItemType Directory -Force $INSTDIR | Out-Null
  $sysSid   = [Security.Principal.SecurityIdentifier]'S-1-5-18'       # LocalSystem
  $adminSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'   # Administrators
  $userSid  = [Security.Principal.SecurityIdentifier]'S-1-5-32-545'   # Users
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)                        # drop inheritance
  $inh = 'ContainerInherit,ObjectInherit'
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sysSid,   'FullControl',  $inh,'None','Allow')))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($adminSid, 'FullControl',  $inh,'None','Allow')))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid,  'ReadAndExecute',$inh,'None','Allow')))
  $acl.SetOwner($adminSid)
  Set-Acl -Path $INSTDIR -AclObject $acl
  $installed = Join-Path $INSTDIR 'sync-hma.ps1'
  Copy-Item $PSCommandPath $installed -Force
  Set-Acl -Path $installed -AclObject $acl                           # file inherits locked ACL

  $psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installed`" -Quiet -Inbox `"$Inbox`" -Port `"$Port`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
  $atLogon = New-ScheduledTaskTrigger -AtLogOn
  $every6h = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TASK -Action $action -Trigger $atLogon, $every6h `
    -Principal $principal -Settings $settings -Description 'Proxy Farm: tự lấy & làm mới đăng nhập HMA' -Force | Out-Null
  Write-Host "[OK] Đã bật tự động đồng bộ (bản script khoá quyền ở $installed)." -ForegroundColor Green
  Write-Host "      Từ giờ farm tự làm mới đăng nhập HMA — không cần bấm gì nữa. Gỡ: sync-hma.bat uninstall"
}

Pause-IfNeeded
