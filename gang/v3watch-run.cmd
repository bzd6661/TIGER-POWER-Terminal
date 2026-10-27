@echo off
rem Gang V3 watcher, monitor only (Telegram alerts, never trades). Restarts 10s after a crash.
cd /d "%~dp0.."
:loop
node gang/v3watch.mjs
timeout /t 10 /nobreak >nul
goto loop
