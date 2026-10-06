@echo off
REM Proxy Farm - Windows stop. Stops the manager. Proxy ports keep running until you
REM turn them off in the UI (or run: docker compose down to stop the manager only).
setlocal
cd /d "%~dp0"
title Proxy Farm - stop
echo Dang dung manager Proxy Farm...
docker compose down
echo.
echo [OK] Da dung manager. Cac cong proxy dang chay van giu nguyen^; tat chung trong giao dien truoc khi chay neu muon dung han.
echo     Chay lai: bam dup run.bat
echo.
pause
