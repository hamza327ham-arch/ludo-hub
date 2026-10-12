@echo off
title Ludo Hub server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Opening the download page. Install the LTS version, then double-click start.bat again.
  echo  ^(Playing alone or on one device does NOT need this: just open index.html.^)
  start https://nodejs.org
  pause
  exit /b
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
