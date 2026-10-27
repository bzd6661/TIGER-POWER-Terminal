@echo off
rem Double-click to open the panel. All checks live in setup.mjs (Node prints Chinese reliably; cmd does not).
cd /d "%~dp0.."
where node >nul 2>nul || goto nonode
node "%~dp0setup.mjs"
if errorlevel 1 pause
exit /b

:nonode
echo [x] Node.js not found. Install Node.js 20 or newer from https://nodejs.org , then double-click start.cmd again.
start "" https://nodejs.org
pause
