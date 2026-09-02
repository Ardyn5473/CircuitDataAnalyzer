@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo RCNXファイルをこのBATへドラッグ＆ドロップしてください。
  pause
  exit /b 1
)
where py >nul 2>nul
if %errorlevel%==0 (py rcnx_to_csv.py "%~1" "%~dp0OUTPUT" & pause & exit /b)
where python >nul 2>nul
if %errorlevel%==0 (python rcnx_to_csv.py "%~1" "%~dp0OUTPUT" & pause & exit /b)
echo Pythonがインストールされていません。
pause
