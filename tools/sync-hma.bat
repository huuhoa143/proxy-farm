@echo off
REM Sync HMA into Proxy Farm - Windows. Double-click me.
REM
REM The HMA Windows app logs in over OpenVPN with a username/password kept in an
REM Administrators-only folder (it has no IKEv2 certificate like the macOS app). This
REM reads it and hands it to the farm; a UAC prompt appears because that needs admin.
REM
REM   sync-hma.bat            sync the login once (fast; farm uses its built-in server list)
REM   sync-hma.bat install    hands-off auto-sync: a scheduled task refreshes the login
REM                           into the farm every few hours and at logon (one UAC now,
REM                           then nothing to click again) -- recommended
REM   sync-hma.bat uninstall  remove the auto-sync task
REM   sync-hma.bat full       also re-scan every location's current server IP
REM                           (slower, and briefly cycles your own VPN while it runs)
set "MODE="
if /I "%~1"=="install"   set "MODE=-Install"
if /I "%~1"=="uninstall" set "MODE=-Uninstall"
if /I "%~1"=="full"      set "MODE=-Full"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-hma.ps1" %MODE%
