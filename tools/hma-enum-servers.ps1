<#
  Enumerate each HMA location's current OpenVPN server IP, by driving the HMA app's own
  local UI API over the Chrome DevTools Protocol (the app is a CEF/Chromium shell). The
  app hands out a server IP per connection and persists it nowhere, so the only way to
  learn a location's IP is to let the app connect to it and read the openvpn.exe command
  line it launches. This connects and disconnects each location in turn, so it briefly
  cycles your own VPN and takes several minutes.

  Returns a catalog object: @{ fetched=<unix>; locations=@(@{key;country;countryName;city;ip;port;proto}) }
  Intended to be dot-sourced / called by sync-hma.ps1 -Full; its stdout is the catalog.
#>
$ErrorActionPreference = 'Stop'
$exe = @(
  "$env:ProgramFiles\Privax\HMA VPN\Vpn.exe",
  "${env:ProgramFiles(x86)}\Privax\HMA VPN\Vpn.exe",
  "$env:ProgramFiles\HMA VPN\Vpn.exe",
  "$env:ProgramFiles\Privax\HMA! Pro VPN\Vpn.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { throw "Không tìm thấy app HMA (Vpn.exe) trong Program Files" }

# ---- minimal Chrome DevTools Protocol client (pure PowerShell) -------------------
function Connect-Cdp {
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $pages = Invoke-RestMethod "http://127.0.0.1:9222/json" -TimeoutSec 3
      $page = $pages | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
      if ($page) {
        $ws = [System.Net.WebSockets.ClientWebSocket]::new()
        $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
        return $ws
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw "Không mở được cổng điều khiển của app HMA (9222)"
}
$script:cdpId = 0
function Invoke-Cdp($ws, $expr) {
  $script:cdpId++
  $id = $script:cdpId
  $msg = @{ id = $id; method = 'Runtime.evaluate'; params = @{ expression = $expr; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Depth 6 -Compress
  $buf = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($buf), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 25) {
    $sb = [Text.StringBuilder]::new()
    do {
      $seg = [ArraySegment[byte]]::new([byte[]]::new(16384))
      if ($ws.State -ne 'Open') { throw "WebSocket đã đóng" }
      $res = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None); $res.Wait()
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($seg.Array, 0, $res.Result.Count))
    } while (-not $res.Result.EndOfMessage)
    $o = $sb.ToString() | ConvertFrom-Json
    if ($o.id -eq $id) { return $o.result.result.value }
  }
  throw "CDP timeout"
}
function Status($ws) { Invoke-Cdp $ws "NAPI.request('app.vpn.GetStatus').then(s=>s.vpnStatus)" }

# ---- (re)launch the app with the debug port --------------------------------------
# The app is single-instance: a second launch just signals the running one and exits, so
# the debug port never opens unless we fully stop it first. Kill every Vpn.exe and wait
# until they are really gone before relaunching with the port.
function Stop-Hma {
  Get-Process Vpn -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20; $i++) { if (-not (Get-Process Vpn -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 300 }
}
$alreadyDebug = $false
try { Invoke-RestMethod "http://127.0.0.1:9222/json" -TimeoutSec 2 | Out-Null; $alreadyDebug = $true } catch {}
if (-not $alreadyDebug) {
  Stop-Hma
  Start-Sleep 1
  Start-Process $exe -ArgumentList '--remote-debugging-port=9222'
}
$ws = Connect-Cdp

try {
  Invoke-Cdp $ws "NAPI.request('app.vpn.WriteUserSettings',{PreferredProtocol:'openvpn'})" | Out-Null
  $raw = Invoke-Cdp $ws "NAPI.request('app.vpn.GetGatewayList').then(g=>JSON.stringify(g.map(x=>({id:x.id,cc:x.country.id,cn:x.country.name,city:x.city.name}))))"
  $gws = $raw | ConvertFrom-Json
  Write-Host "    $($gws.Count) vị trí — bắt đầu dò…"
  $locations = @()
  $n = 0
  foreach ($g in $gws) {
    $n++
    Invoke-Cdp $ws "NAPI.request('app.vpn.ConnectToGateway','$($g.id)')" | Out-Null
    $ip = $null; $port = 1194; $proto = 'udp'
    for ($t = 0; $t -lt 40; $t++) {
      $p = Get-CimInstance Win32_Process -Filter "Name='openvpn.exe'" -ErrorAction SilentlyContinue
      if ($p) {
        $m = [regex]::Match([string]$p.CommandLine, '--remote (\d+\.\d+\.\d+\.\d+) (\d+) (\w+)')
        if ($m.Success) { $ip = $m.Groups[1].Value; $port = [int]$m.Groups[2].Value; $proto = $m.Groups[3].Value }
      }
      if ($ip -and (Status $ws) -eq 'connected') { break }
      Start-Sleep -Milliseconds 400
    }
    Invoke-Cdp $ws "NAPI.request('app.vpn.Disconnect')" | Out-Null
    for ($t = 0; $t -lt 30; $t++) { if ((Status $ws) -eq 'disconnected' -and -not (Get-Process openvpn -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 400 }
    if ($ip) { $locations += @{ key = $g.id; country = $g.cc; countryName = $g.cn; city = $g.city; ip = $ip; port = $port; proto = $proto } }
    Write-Host ("    [{0}/{1}] {2} -> {3}" -f $n, $gws.Count, $g.id, $(if ($ip) { $ip } else { 'skip' }))
  }
  $epoch = [int64](([datetime]::UtcNow) - [datetime]'1970-01-01').TotalSeconds
  return @{ fetched = $epoch; locations = $locations }
}
finally {
  try { Invoke-Cdp $ws "NAPI.request('app.vpn.WriteUserSettings',{PreferredProtocol:'automatic'})" | Out-Null } catch {}
  try { $ws.Dispose() } catch {}
  # relaunch the app normally (without the debug port)
  Stop-Hma
  Start-Sleep 1
  Start-Process $exe
}
