<#
.SYNOPSIS
  Local end-to-end Windows x64 release for Proxy Farm (UNSIGNED NSIS).

.DESCRIPTION
  Windows counterpart of scripts/local-release.sh (macOS), ported from
  lingoreup's scripts/local-release.ps1 without its Python/venv/cythonize/wasm
  stages (Proxy Farm has none). HMA support on Windows needs no extra binary:
  the app registers its credentials task itself (src/main/bootstrap/hma-windows.ts).

  Unsigned like lingoreup v1: users see a one-time SmartScreen prompt;
  Authenticode can be added later through the NSIS maker's `codesigning`
  option in forge.config.ts (spec section 9).

  This file is ASCII only: Windows PowerShell 5.1 reads a BOM-less script in
  the ANSI code page, where UTF-8 punctuation can turn into quote characters.

  Pipeline:
    1. Prereqs (pnpm, node, git; gh unless -DryRun) + clean git tree
    2. Release gate: type check + unit tests
    3. Version bump + commit + tag + push              (skipped by -DryRun)
    4. electron-forge make -> NSIS installer + latest.yml + .blockmap
    5. Smoke: the packaged sing-box is the pinned build; the packaged app
       starts, opens its window and quits cleanly through `--quit`
       leaving no engine behind; latest.yml matches the installer
    6. gh release create/upload: Setup.exe + latest.yml + .blockmap + the
       sing-box source tarball (GPLv3 section 6)    (skipped by -DryRun)

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\local-release.ps1 0.2.0
    ... 0.2.0 -Resume     # resume after a transient failure
    ... 0.2.0 -DryRun     # build + smoke only: no git or GitHub writes

  GH_TOKEN is derived from `gh auth token -u huuhoa143` when unset.
#>

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Version,
  [switch]$Resume,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
  throw "VERSION must be X.Y.Z (got: $Version)"
}

# scripts\local-release.ps1 lives at app\scripts\: ROOT is app\.
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT
$StatePath = Join-Path $ROOT '.release-state-win.json'
$GhRepo = 'huuhoa143/proxy-farm'
$PackagedDir = Join-Path $ROOT 'out\Proxy Farm-win32-x64'

# --- console helpers -------------------------------------------------------
function Bold($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Green($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Red($m) { Write-Host $m -ForegroundColor Red }

# --- state (JSON) ----------------------------------------------------------
function State-Load {
  if (Test-Path $StatePath) {
    return Get-Content $StatePath -Raw | ConvertFrom-Json
  }
  return $null
}
function State-Save($state) {
  $state | ConvertTo-Json -Depth 6 | Set-Content -Path $StatePath -Encoding utf8
}
function State-Init($ver) {
  $s = [pscustomobject]@{ version = $ver; steps_done = @(); data = [pscustomobject]@{} }
  State-Save $s
  return $s
}
function State-IsDone($state, $step) { return ($state.steps_done -contains $step) }
function State-MarkDone($state, $step) {
  if ($state.steps_done -notcontains $step) {
    $state.steps_done = @($state.steps_done) + $step
    State-Save $state
  }
}

# Every running sing-box.exe (the app's engines).
function Get-Engines { @(Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue) }

try {
  # =====================================================================
  # Step 1 - Prereqs
  # =====================================================================
  Bold '1/6  Checking prerequisites'
  $required = @('pnpm', 'node', 'git')
  if (-not $DryRun) { $required += 'gh' }
  $missing = $required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
  if ($missing) { throw "Missing required tools: $($missing -join ', ')" }

  if ((-not $DryRun) -and (-not $env:GH_TOKEN)) {
    $ghAuthOk = $false
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      gh auth status --hostname github.com 2>&1 | Out-Null
      $ghAuthOk = ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $prevEap }
    if (-not $ghAuthOk) {
      $token = (gh auth token -u huuhoa143 2>$null)
      if ($token) { $env:GH_TOKEN = $token } else { throw 'GH_TOKEN unset AND gh CLI not authenticated' }
    }
  }

  if (-not (Test-Path (Join-Path $ROOT 'node_modules'))) {
    Warn 'node_modules missing - running pnpm install...'
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
  }

  $tracked = git status --porcelain | Where-Object { $_ -notmatch '^\?\?' }
  if ($tracked) {
    git status --short
    throw 'Working tree has uncommitted tracked changes. Commit or stash first.'
  }
  try { git fetch origin --quiet 2>$null } catch { Warn 'git fetch origin failed (non-fatal)' }
  $currentVersion = (Get-Content (Join-Path $ROOT 'package.json') -Raw | ConvertFrom-Json).version

  if ($Resume) {
    $state = State-Load
    if (-not $state) { throw 'No .release-state-win.json to resume from' }
    if ($state.version -ne $Version) { throw "State is for v$($state.version) but you asked v$Version" }
    Green "Resuming v$Version (done: $($state.steps_done -join ','))"
  } else {
    if ((-not $DryRun) -and ($currentVersion -eq $Version)) {
      throw "Already at v$Version. Bump to a fresh version, or use -Resume."
    }
    $state = State-Init $Version
  }
  if (Get-Engines) { throw 'A sing-box engine is running: quit Proxy Farm first (the smoke step counts engines).' }
  Green "Prereqs OK ($currentVersion -> $Version; dry-run=$DryRun; resume=$Resume)"

  # =====================================================================
  # Step 2 - Release gate: type check + unit tests
  # =====================================================================
  if (-not (State-IsDone $state 'gate')) {
    Bold '2/6  Release gate (tsc --noEmit + vitest)'
    pnpm exec tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'type check failed' }
    pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'unit tests failed' }
    State-MarkDone $state 'gate'
  } else { Green '2/6  Release gate (skipped)' }

  # =====================================================================
  # Step 3 - Bump + commit + tag + push
  # =====================================================================
  if (-not (State-IsDone $state 'bump')) {
    Bold '3/6  Version bump + commit + tag + push'
    if ($DryRun) {
      Write-Host "  [dry-run] Would bump $currentVersion -> $Version + commit + tag + push"
    } else {
      $branch = (git branch --show-current).Trim()
      $pkgPath = Join-Path $ROOT 'package.json'
      $pkg = Get-Content $pkgPath -Raw
      $pkg = $pkg -replace '("version"\s*:\s*")[0-9]+\.[0-9]+\.[0-9]+(")', "`${1}$Version`${2}"
      [System.IO.File]::WriteAllText($pkgPath, $pkg, (New-Object System.Text.UTF8Encoding($false)))
      git add package.json
      if ($LASTEXITCODE -ne 0) { throw 'git add package.json failed' }
      git commit -m "chore: bump version to $Version"
      if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
      git push origin $branch
      if ($LASTEXITCODE -ne 0) { throw "git push origin $branch failed" }
      git tag "v$Version"
      if ($LASTEXITCODE -ne 0) { throw "git tag v$Version failed - tag already exists? To attach a Windows build to an existing release, seed .release-state-win.json with steps_done:['gate','bump'] and use -Resume." }
      git push origin "v$Version"
      if ($LASTEXITCODE -ne 0) { throw "git push origin v$Version failed" }
      Green "Tag v$Version pushed"
    }
    State-MarkDone $state 'bump'
  } else { Green '3/6  Bump (skipped)' }

  # =====================================================================
  # Step 4 - electron-forge make -> NSIS installer (win32/x64, UNSIGNED)
  # =====================================================================
  if (-not (State-IsDone $state 'make')) {
    Bold '4/6  electron-forge make (Vite + Electron pack + NSIS)'
    Set-Location $ROOT
    if (Test-Path (Join-Path $ROOT 'out')) { Remove-Item -Recurse -Force (Join-Path $ROOT 'out') }
    # Do NOT set CI: the NSIS maker (electron-builder) auto-publishes to GitHub when it
    # detects CI and then fails without GH_TOKEN wired the way it expects.
    Remove-Item Env:\CI -ErrorAction SilentlyContinue
    # The pinned sing-box (and its source tarball) must be present: forge's hook copies it.
    node scripts/prebuild-singbox.mjs
    if ($LASTEXITCODE -ne 0) { throw 'sing-box prebuild failed' }
    pnpm exec electron-forge make
    if ($LASTEXITCODE -ne 0) { throw 'electron-forge make failed' }
    State-MarkDone $state 'make'
  } else { Green '4/6  make (skipped)' }

  $nsisDir = Get-ChildItem (Join-Path $ROOT 'out\make\nsis') -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { Get-ChildItem $_.FullName -Filter '*.exe' -ErrorAction SilentlyContinue } |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $nsisDir) {
    $nsisRoot = Join-Path $ROOT 'out\make\nsis'
    if ((Test-Path $nsisRoot) -and (Get-ChildItem $nsisRoot -Filter '*.exe' -ErrorAction SilentlyContinue)) { $nsisDir = $nsisRoot }
  }
  if (-not $nsisDir) { throw 'NSIS output dir not found under out\make\nsis' }

  # =====================================================================
  # Step 5 - Smoke the packaged bits before anything is uploaded
  # =====================================================================
  if (-not (State-IsDone $state 'smoke')) {
    Bold '5/6  Smoke - packaged sing-box, app start + --quit, latest.yml'
    $exe = Join-Path $PackagedDir 'Proxy Farm.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "packaged app missing: $exe" }

    # (a) the bundled engine is the pinned build with every required tag.
    $pins = Get-Content (Join-Path $ROOT 'scripts\singbox.pins.json') -Raw | ConvertFrom-Json
    $singbox = Join-Path $PackagedDir 'resources\sing-box\windows-amd64\sing-box.exe'
    $versionOut = (& $singbox version) -join "`n"
    if ($versionOut -notmatch "sing-box version $([regex]::Escape($pins.version))") { throw "packaged sing-box is not $($pins.version): $versionOut" }
    foreach ($tag in 'with_gvisor', 'with_wireguard', 'with_openvpn') {
      if ($versionOut -notmatch $tag) { throw "packaged sing-box lacks $tag" }
    }
    foreach ($res in 'ca\sectigo-r46.pem', 'ca\zoogvpn-ca.pem', 'ca\zoogvpn-tls-auth.key', 'ca\expressvpn-ca.pem', 'ca\expressvpn-client.crt', 'ca\expressvpn-client.key', 'ca\expressvpn-tls-auth.key', 'catalogs\hma-ovpn-seed.json', 'catalogs\zoogvpn-servers.json', 'catalogs\expressvpn-servers.json', 'app-update.yml') {
      if (-not (Test-Path -LiteralPath (Join-Path $PackagedDir "resources\$res"))) { throw "packaged resource missing: $res" }
    }
    Green "  sing-box $($pins.version) with gvisor/wireguard/openvpn; resources present"

    # (b) the app starts with a throwaway profile, opens its window, then quits cleanly.
    $smokeProfile = Join-Path $env:TEMP "pf-release-smoke-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $smokeProfile | Out-Null
    $prevProfile = $env:PROXYFARM_USER_DATA_DIR
    $env:PROXYFARM_USER_DATA_DIR = $smokeProfile
    try {
      $proc = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=0' -PassThru
      $portFile = Join-Path $smokeProfile 'DevToolsActivePort'
      $deadline = (Get-Date).AddSeconds(60)
      $rendererUp = $false
      while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
        if (Test-Path -LiteralPath $portFile) {
          $port = (Get-Content -LiteralPath $portFile | Select-Object -First 1)
          try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3
            if (@($targets | Where-Object { $_.type -eq 'page' -and $_.url -match 'index\.html' }).Count -gt 0) { $rendererUp = $true; break }
          } catch { }
        }
        Start-Sleep -Milliseconds 500
      }
      if ($proc.HasExited) { throw "packaged app exited during startup (code $($proc.ExitCode))" }
      if (-not $rendererUp) { throw 'packaged app never showed its window within 60 s' }
      Green '  app started and loaded its window'

      $quitter = Start-Process -FilePath $exe -ArgumentList '--quit' -PassThru
      if (-not $proc.WaitForExit(30000)) { throw 'packaged app did not quit within 30 s of --quit' }
      $null = $quitter.WaitForExit(10000)
      if (Get-Engines) { throw 'a sing-box engine outlived the app' }
      Green "  --quit exited cleanly (code $($proc.ExitCode)), no engine left"
    } finally {
      if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
      $env:PROXYFARM_USER_DATA_DIR = $prevProfile
      Start-Sleep -Milliseconds 500
      Remove-Item -Recurse -Force -LiteralPath $smokeProfile -ErrorAction SilentlyContinue
    }

    # (c) latest.yml names the installer and carries its sha512.
    $installer = Get-ChildItem $nsisDir -File -Filter '*.exe' | Select-Object -First 1
    $ymlPath = Join-Path $nsisDir 'latest.yml'
    if (-not (Test-Path -LiteralPath $ymlPath)) { throw 'latest.yml missing next to the installer' }
    $yml = Get-Content -LiteralPath $ymlPath -Raw
    $sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($installer.FullName)))
    if (-not $yml.Contains($sha512)) { throw "latest.yml does not carry the installer's sha512" }
    if ($yml -notmatch "version:\s*$([regex]::Escape((Get-Content (Join-Path $ROOT 'package.json') -Raw | ConvertFrom-Json).version))") { throw 'latest.yml version differs from package.json' }
    Green "  latest.yml matches $($installer.Name) ($([math]::Round($installer.Length / 1MB, 1)) MB)"
    State-MarkDone $state 'smoke'
  } else { Green '5/6  Smoke (skipped)' }

  if ($DryRun) {
    Write-Host ''
    Warn '[dry-run] complete: prereqs + gate + make + smoke.'
    Warn "[dry-run] Installer: $nsisDir"
    Warn '[dry-run] Skipped: git bump/tag/push, gh release.'
    if (Test-Path $StatePath) { Remove-Item -Force $StatePath }
    return
  }

  # =====================================================================
  # Step 6 - gh release create/upload (Setup.exe + latest.yml + .blockmap + sing-box source)
  # =====================================================================
  if (-not (State-IsDone $state 'gh_release')) {
    Bold '6/6  gh release create + upload'

    # Installer filename parity (space -> dot): electron-builder names the installer
    # "<productName> Setup <ver>.exe" and writes that spaced name into latest.yml. GitHub
    # replaces spaces with dots on upload, so electron-updater would 404 on the %20 URL
    # (lingoreup v0.3.6). Rename locally and rewrite latest.yml to match.
    $installer = Get-ChildItem $nsisDir -File -Filter '*.exe' | Select-Object -First 1
    if ($installer -and ($installer.Name -match ' ')) {
      $oldExe = $installer.Name
      $newExe = $oldExe -replace ' ', '.'
      Rename-Item -LiteralPath $installer.FullName -NewName $newExe
      $oldMap = Join-Path $nsisDir "$oldExe.blockmap"
      if (Test-Path -LiteralPath $oldMap) { Rename-Item -LiteralPath $oldMap -NewName "$newExe.blockmap" }
      $ymlPath = Join-Path $nsisDir 'latest.yml'
      if (Test-Path -LiteralPath $ymlPath) {
        $yml = (Get-Content -LiteralPath $ymlPath -Raw).Replace($oldExe, $newExe)
        [System.IO.File]::WriteAllText($ymlPath, $yml, (New-Object System.Text.UTF8Encoding($false)))
      }
      Warn "  Normalized installer name: '$oldExe' -> '$newExe' (GitHub asset/latest.yml parity)"
    }

    # sing-box GPL source tarball (GPLv3 section 6), pinned by scripts/prebuild-singbox.mjs.
    $pins = Get-Content (Join-Path $ROOT 'scripts\singbox.pins.json') -Raw | ConvertFrom-Json
    $srcTarball = Join-Path $ROOT "resources\sing-box-src\$($pins.sourceTarball.fileName)"
    if (-not (Test-Path $srcTarball)) {
      throw "sing-box source tarball missing: $srcTarball (run: node scripts\prebuild-singbox.mjs)"
    }

    $assets = @(Get-ChildItem $nsisDir -File | Where-Object { $_.Extension -in '.exe', '.blockmap' -or $_.Name -eq 'latest.yml' })
    $assets += Get-Item $srcTarball
    Write-Host '  Artifacts:'; $assets | ForEach-Object { Write-Host "    $($_.Name) ($([math]::Round($_.Length/1MB,1)) MB)" }

    $assetPaths = $assets | ForEach-Object { $_.FullName }
    $releaseExists = $false
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      gh release view "v$Version" --repo $GhRepo 2>&1 | Out-Null
      $releaseExists = ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $prevEap }
    if ($releaseExists) {
      gh release upload "v$Version" --repo $GhRepo --clobber @assetPaths
      if ($LASTEXITCODE -ne 0) { throw 'gh release upload failed' }
    } else {
      $log = git log --pretty='- %s' "v$currentVersion..v$Version" 2>$null
      if (-not $log) { $log = git log --pretty='- %s' -10 }
      $notes = "Proxy Farm Windows x64 release v$Version`n`n## Changes since v$currentVersion`n`n$($log -join "`n")"
      gh release create "v$Version" --repo $GhRepo --title "v$Version" --notes $notes @assetPaths
      if ($LASTEXITCODE -ne 0) { throw 'gh release create failed' }
    }
    Green "Release assets uploaded to v$Version"
    State-MarkDone $state 'gh_release'
  } else { Green '6/6  gh release (skipped)' }

  Write-Host ''
  Green "Windows release v$Version complete"
  Write-Host "    https://github.com/$GhRepo/releases/tag/v$Version"

  if (Test-Path $StatePath) { Remove-Item -Force $StatePath }
}
catch {
  Red "Release failed: $($_.Exception.Message)"
  throw
}
