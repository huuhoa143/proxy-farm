@echo off
setlocal
REM Sync HMA into Proxy Farm - Windows. Double-click me.
REM
REM The HMA Windows app logs in over OpenVPN with a username/password kept in an
REM Administrators-only folder (it has no IKEv2 certificate like the macOS app). This
REM reads it and hands it to the farm; a UAC prompt appears because that needs admin.
REM
REM   sync-hma.bat            sync the login once (fast; farm uses its built-in server list)
REM   sync-hma.bat install    hands-off auto-sync via a scheduled task (recommended)
REM   sync-hma.bat uninstall  remove the auto-sync task
REM   sync-hma.bat full       also re-scan every location's current server IP (cycles VPN)

set "MODE="
if /I "%~1"=="install"   set "MODE=-Install"
if /I "%~1"=="uninstall" set "MODE=-Uninstall"
if /I "%~1"=="full"      set "MODE=-Full"

REM Elevate THIS window (and wait) so there is one coherent window that stays open,
REM instead of the script spawning a separate admin window that vanishes on any error.
net session >nul 2>&1
if %errorlevel%==0 goto run
echo Can quyen admin de doc dang nhap tu app HMA - dang mo hop thoai UAC...
if "%~1"=="" (
  powershell -NoProfile -Command "Start-Process -Wait -Verb RunAs -FilePath '%~f0'"
) else (
  powershell -NoProfile -Command "Start-Process -Wait -Verb RunAs -FilePath '%~f0' -ArgumentList '%~1'"
)
goto :eof

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-hma.ps1" %MODE% -Quiet
echo.
pause
