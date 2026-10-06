@echo off
REM Proxy Farm - Windows one-click start. Double-click me (no terminal needed).
REM Equivalent of run.sh: makes the data folders, writes .env for docker compose,
REM builds and starts the manager, and opens the UI. Re-run any time.
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Proxy Farm

REM ---- make sure Docker is running --------------------------------------------
docker info >nul 2>&1
if not errorlevel 1 goto docker_ok
echo Docker chua chay - dang mo Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
) else (
  echo [X] Khong tim thay Docker Desktop. Hay cai Docker Desktop truoc: https://www.docker.com/products/docker-desktop/
  pause & exit /b 1
)
echo Doi Docker khoi dong ^(co the mat 1-2 phut^)...
for /l %%i in (1,1,60) do (
  >nul timeout /t 3 /nobreak
  docker info >nul 2>&1 && goto docker_ok
)
echo [X] Docker van chua san sang. Mo Docker Desktop thu cong roi chay lai file nay.
pause & exit /b 1
:docker_ok

REM ---- data folders -----------------------------------------------------------
set "FARM_WIN=%USERPROFILE%\proxy-farm"
for %%D in (secrets status configs data inbox .noscan) do (
  if not exist "%FARM_WIN%\%%D" mkdir "%FARM_WIN%\%%D" >nul 2>&1
)

REM ---- .env for docker compose (keep an existing one) -------------------------
if exist ".env" goto have_env
REM Docker compose wants a POSIX-style path: C:\Users\Me -> /c/Users/Me
set "P=%FARM_WIN%"
set "DRV=%P:~0,1%"
set "REST=%P:~2%"
set "REST=!REST:\=/!"
set "DL=%DRV%"
for %%L in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do if /I "%DRV%"=="%%L" set "DL=%%L"
set "FARM=/!DL!!REST!"
(
  echo FARM=!FARM!
  echo PORT=8090
  echo BIND=127.0.0.1
  echo SCAN=!FARM!/.noscan
  echo # Port containers are created by the manager, not by compose; don't warn about them.
  echo COMPOSE_IGNORE_ORPHANS=true
) > .env
echo [OK] Da tao .env ^(du lieu luu o %FARM_WIN%^)
:have_env

REM ---- build + start ----------------------------------------------------------
echo Dang build va khoi dong farm ^(lan dau co the mat vai phut^)...
docker compose build -q node manager
if errorlevel 1 ( echo [X] Build that bai. & pause & exit /b 1 )
docker compose up -d manager
if errorlevel 1 ( echo [X] Khoi dong that bai. & pause & exit /b 1 )
docker image prune -f --filter label=proxy-farm >nul 2>&1

REM ---- open the UI ------------------------------------------------------------
set "PORT=8090"
for /f "usebackq tokens=2 delims==" %%P in (`findstr /b "PORT=" .env`) do set "PORT=%%P"
echo.
echo [OK] Proxy Farm dang chay: http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
echo.
echo Buoc tiep theo cho HMA tren Windows:
echo   bam dup  tools\sync-hma.bat install   ^(bam Yes o UAC mot lan^)
echo Sau do mo "Them vi tri" trong giao dien de bat cong.
echo.
pause
