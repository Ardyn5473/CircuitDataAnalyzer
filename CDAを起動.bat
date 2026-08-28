@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Circuit Data Analyzer - launcher
rem
rem  Serves this folder at http://localhost:8123 and opens it.
rem  This is needed only for YouTube video sync: YouTube refuses to
rem  embed a player on a page opened directly as file:// .
rem  Everything else works fine by just double-clicking index.html.
rem
rem  A small server window stays open. Close it to stop the server.
rem ============================================================

set PORT=8123

where python >nul 2>nul
if errorlevel 1 goto NOPYTHON

start "CDA server - close this window to stop" /min python -m http.server %PORT% --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/index.html"
exit /b

:NOPYTHON
echo.
echo  Python was not found, so the local server cannot be started.
echo  Opening the file directly instead.
echo.
echo  CSV analysis, lap comparison and LOCAL VIDEO FILE sync all work.
echo  Only YouTube sync is unavailable in this mode.
echo.
start "" "%~dp0index.html"
pause
