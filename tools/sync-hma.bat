@echo off
REM Sync HMA device certificate into Proxy Farm - Windows, double-clickable.
REM
REM The HMA app keeps its certificate outside anything Docker Desktop shares, so the
REM container cannot read it. This copies it into the farm inbox; the farm imports it
REM within a minute (or press "Sync" in the UI). Run on a machine that has the HMA app
REM installed and signed in. Double-click in Explorer.
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

REM Farm data dir (inbox). Default; override by setting FARM before running.
if "%FARM%"=="" set "FARM=%USERPROFILE%\proxy-farm"
set "INBOX=%FARM%\inbox"
if not exist "%INBOX%" mkdir "%INBOX%" >nul 2>&1

REM Candidate locations for the device token across HMA builds.
set "SRC="
for %%P in (
  "%ProgramData%\HMA VPN\state\vpn\tokenCoreSE.json"
  "%ProgramData%\HMA! Pro VPN\state\vpn\tokenCoreSE.json"
  "%LOCALAPPDATA%\HMA VPN\state\vpn\tokenCoreSE.json"
  "%APPDATA%\HMA VPN\state\vpn\tokenCoreSE.json"
) do (
  if exist "%%~P" if not defined SRC set "SRC=%%~P"
)

if not defined SRC (
  echo [X] Khong tim thay chung chi HMA tren may nay.
  echo     Hay cai app HMA VPN va dang nhap ^(bang activation code^) truoc, roi chay lai.
  echo.
  pause
  exit /b 1
)

copy /y "%SRC%" "%INBOX%\tokenCoreSE.json" >nul
echo [OK] Da sao chep chung chi vao farm.
echo      Nguon: %SRC%
echo      Farm:  %INBOX%

REM Nudge the farm to import right away (best-effort; it also auto-scans every minute).
set "PORT=8090"
curl -s -m 5 -X POST "http://127.0.0.1:%PORT%/api/provider/hma-sync" -d "{}" >nul 2>&1 && (
  echo [OK] Da bao farm nap ngay.
) || (
  echo      Farm se tu nap trong vong 1 phut ^(hoac bam nut Sync trong giao dien^).
)
echo.
pause
