@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py rcnx_to_csv.py --watch "%~dp0RCNX_INBOX" "%~dp0OUTPUT"
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  python rcnx_to_csv.py --watch "%~dp0RCNX_INBOX" "%~dp0OUTPUT"
  goto :eof
)
echo.
echo Pythonがインストールされていません。
echo Microsoft Storeまたはpython.orgからPython 3をインストールしてください。
pause
