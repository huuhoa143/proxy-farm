<#
.SYNOPSIS
  Local end-to-end Windows x64 release for Proxy Farm (UNSIGNED NSIS).

.DESCRIPTION
  Windows counterpart of scripts/local-release.sh (macOS). Ported from
  lingoreup's scripts/local-release.ps1, with every Python/venv/cythonize/
  wasm stage DROPPED (Proxy Farm has none of that) and one stage ADDED that
  lingoreup never needed: building the Go Windows helper (spec §7) before
  packaging, since forge needs it present as an extraResource.

  The macOS-only stages (Apple codesign / notarytool / stapler / spctl /
  create-dmg) are intentionally absent here, same as lingoreup v1: this
  ships an UNSIGNED NSIS installer. Users see a one-time SmartScreen
  prompt; Authenticode is a later addition via the maker's own
  `config.codesigning` hook (left in forge.config.ts, untouched by this
  script — spec §9: "a signing hook kept in the maker config").

  THIS SCRIPT RUNS ON WINDOWS. It was authored and syntax-reviewed on
  macOS (no pwsh available in that environment to execute it) — treat it
  as unverified until it runs for real on a Windows box. See the release
  report for exactly what was and wasn't checked.

  Pipeline (~5-10 min, no Apple steps):
    1. Prereqs check (pnpm, gh, node, git) + clean git tree
    2. Build the Go helper (helper/) — SKIPPED with a clear message if
       helper/ doesn't exist yet (it's built in a later track; do not fail)
    3. Version bump + commit + tag + push
    4. pnpm run make → NSIS installer (@electron-addons/electron-forge-maker-nsis,
       UNSIGNED — signing hook stays in forge.config.ts for later)
    5. gh release create/upload: Setup.exe + latest.yml + .blockmap + the
       sing-box source tarball (GPLv3 §6)

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\local-release.ps1 0.1.0
    ... 0.1.0 -Resume     # resume after a transient failure
    ... 0.1.0 -DryRun     # rehearse through build, no git/GitHub writes

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

# scripts\local-release.ps1 lives at app\scripts\ — ROOT is app\, REPO_ROOT
# is one level above it (where helper\ lives per spec §8).
$ROOT = Split-Path -Parent $PSScriptRoot
$REPO_ROOT = Split-Path -Parent $ROOT
Set-Location $ROOT
$StatePath = Join-Path $ROOT '.release-state-win.json'
$GhRepo = 'huuhoa143/proxy-farm'
$ProductSlug = 'ProxyFarm'

# ─── console helpers ──────────────────────────────────────────────────────
function Bold($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Green($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Red($m) { Write-Host $m -ForegroundColor Red }

# ─── state (JSON) ──────────────────────────────────────────────────────────
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
function State-Set($state, $key, $val) {
  $state.data | Add-Member -NotePropertyName $key -NotePropertyValue $val -Force
  State-Save $state
}
function State-Get($state, $key) {
  if ($state.data.PSObject.Properties.Name -contains $key) { return $state.data.$key }
  return $null
}

try {
  # ══════════════════════════════════════════════════════════════════════
  # Step 1 — Prereqs
  # ══════════════════════════════════════════════════════════════════════
  Bold '1/5  Checking prerequisites'
  $required = @('pnpm', 'gh', 'node', 'git')
  $missing = $required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
  if ($missing) { throw "Missing required tools: $($missing -join ', ')" }

  if (-not $env:GH_TOKEN) {
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
    Warn 'node_modules missing — running pnpm install…'
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
  Green "Prereqs OK ($currentVersion -> $Version; dry-run=$DryRun; resume=$Resume)"

  # ══════════════════════════════════════════════════════════════════════
  # Step 2 — Build the Go helper (skip, don't fail, if helper/ is absent)
  # ══════════════════════════════════════════════════════════════════════
  # spec §7/§8: helper/ is a Go Windows service + installer/uninstaller exe,
  # built on a later track. Until it lands, this step is a documented no-op
  # rather than a hard failure, so this script stays runnable throughout
  # the parallel build.
  Bold '2/5  Build Go helper (helper/)'
  $helperDir = Join-Path $REPO_ROOT 'helper'
  if (-not (Test-Path $helperDir)) {
    Warn "helper/ not found at $helperDir — skipping (built in a later track, see spec §7/§8)"
  } elseif (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Warn "helper/ exists but Go toolchain not found on PATH — skipping helper build"
  } elseif (Test-Path (Join-Path $helperDir 'build.ps1')) {
    if ($DryRun) {
      Write-Host "  [dry-run] Would run helper\build.ps1"
    } else {
      & (Join-Path $helperDir 'build.ps1')
      if ($LASTEXITCODE -ne 0) { throw 'helper\build.ps1 failed' }
    }
    Green '  helper built via helper\build.ps1'
  } elseif (Test-Path (Join-Path $helperDir 'go.mod')) {
    if ($DryRun) {
      Write-Host "  [dry-run] Would run: go build -o helper.exe . (in helper\)"
    } else {
      Push-Location $helperDir
      try {
        go build -o helper.exe .
        if ($LASTEXITCODE -ne 0) { throw 'go build (helper) failed' }
      } finally { Pop-Location }
    }
    Green '  helper built via go build'
  } else {
    Warn "helper/ exists but has neither build.ps1 nor go.mod — don't know how to build it, skipping"
  }

  # ══════════════════════════════════════════════════════════════════════
  # Step 3 — Bump + commit + tag + push
  # ══════════════════════════════════════════════════════════════════════
  if (-not (State-IsDone $state 'bump')) {
    Bold '3/5  Version bump + commit + tag + push'
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
      if ($LASTEXITCODE -ne 0) { throw "git tag v$Version failed — tag already exists? If attaching a Windows build to an existing release, seed .release-state-win.json with steps_done:['bump'] and use -Resume." }
      git push origin "v$Version"
      if ($LASTEXITCODE -ne 0) { throw "git push origin v$Version failed" }
      Green "Tag v$Version pushed"
    }
    State-MarkDone $state 'bump'
  } else { Green '3/5  Bump (skipped)' }

  # ══════════════════════════════════════════════════════════════════════
  # Step 4 — electron-forge make → NSIS installer (win32/x64, UNSIGNED)
  # ══════════════════════════════════════════════════════════════════════
  if (-not (State-IsDone $state 'make')) {
    Bold '4/5  pnpm run make (Vite + Electron pack + NSIS)'
    Set-Location $ROOT
    if (Test-Path (Join-Path $ROOT 'out')) { Remove-Item -Recurse -Force (Join-Path $ROOT 'out') }
    # Do NOT set CI: the NSIS maker (electron-builder) auto-publishes to
    # GitHub when it detects CI and then fails without GH_TOKEN wired the
    # way it expects. `pnpm exec electron-forge make` is invoked directly
    # so forge builds without attempting to publish itself.
    Remove-Item Env:\CI -ErrorAction SilentlyContinue
    if ($DryRun) {
      Write-Host "  [dry-run] Would run: pnpm exec electron-forge make"
    } else {
      pnpm exec electron-forge make
      if ($LASTEXITCODE -ne 0) { throw 'electron-forge make failed' }
    }
    State-MarkDone $state 'make'
  } else { Green '4/5  pnpm make (skipped)' }

  if ($DryRun) {
    Write-Host ''
    Warn '[dry-run] complete — rehearsed prereqs + helper-build decision + make.'
    Warn '[dry-run] Skipped: git bump/tag/push, gh release.'
    return
  }

  # ══════════════════════════════════════════════════════════════════════
  # Step 5 — gh release create/upload (Setup.exe + latest.yml + .blockmap + sing-box source)
  # ══════════════════════════════════════════════════════════════════════
  if (-not (State-IsDone $state 'gh_release')) {
    Bold '5/5  gh release create + upload'
    $nsisDir = Get-ChildItem (Join-Path $ROOT 'out\make\nsis') -Recurse -Directory |
      Where-Object { Get-ChildItem $_.FullName -Filter '*.exe' -ErrorAction SilentlyContinue } |
      Select-Object -First 1 -ExpandProperty FullName
    if (-not $nsisDir) { throw 'NSIS output dir not found under out\make\nsis' }

    # Installer filename parity (space -> dot): electron-builder names the
    # installer "<productName> Setup <ver>.exe" (WITH spaces — "Proxy Farm"
    # has one even in the product name itself) and writes that exact spaced
    # name into latest.yml's url/path. GitHub replaces spaces with dots on
    # asset upload, so the uploaded asset no longer matches the name inside
    # latest.yml and electron-updater 404s on the %20 URL (verified failure
    # mode in lingoreup v0.3.6). Rename locally + rewrite latest.yml to match.
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

    # sing-box GPL source tarball (GPLv3 §6) — fetched/pinned by
    # scripts/prebuild-singbox.mjs into app\resources\sing-box-src\.
    $pins = Get-Content (Join-Path $ROOT 'scripts\singbox.pins.json') -Raw | ConvertFrom-Json
    $srcTarball = Join-Path $ROOT "resources\sing-box-src\$($pins.sourceTarball.fileName)"
    if (-not (Test-Path $srcTarball)) {
      throw "sing-box source tarball missing: $srcTarball (run: node scripts\prebuild-singbox.mjs)"
    }

    $assets = @(Get-ChildItem $nsisDir -File | Where-Object { $_.Extension -in '.exe', '.blockmap' -or $_.Name -eq 'latest.yml' })
    $assets += Get-Item $srcTarball
    if (-not $assets) { throw "No NSIS artifacts found in $nsisDir" }
    Write-Host "  Artifacts:"; $assets | ForEach-Object { Write-Host "    $($_.Name) ($([math]::Round($_.Length/1MB,1)) MB)" }

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
  } else { Green '5/5  gh release (skipped)' }

  Write-Host ''
  Green "Windows release v$Version complete"
  Write-Host "    https://github.com/$GhRepo/releases/tag/v$Version"

  if (Test-Path $StatePath) { Remove-Item -Force $StatePath }
}
catch {
  Red "Release failed: $($_.Exception.Message)"
  throw
}
