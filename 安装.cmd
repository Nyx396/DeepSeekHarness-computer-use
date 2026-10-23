@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\portable.ps1" -Mode Install %*
set "result=%errorlevel%"
echo.
pause
exit /b %result%
