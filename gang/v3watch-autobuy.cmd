@echo off
rem Gang V3 watcher WITH AUTO-BUY: first 3 tokens on a new Gang pad, 1%% per wallet on both accounts, max 0.2 BNB each.
rem Every buy is still simulated + risk-checked by the Binance wallet first. Edit the numbers below to change.
cd /d "%~dp0.."
:loop
node gang/v3watch.mjs --arm --first 3 --acct both --max-bnb 0.2
timeout /t 10 /nobreak >nul
goto loop
