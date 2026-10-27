@echo off
rem 用账号 2 跑 这个目录里的 four.meme 脚本:four2.cmd fourbuy <CA> <BNB> [选项]  /  four2.cmd foursell <CA> <百分比> [选项]
set "AGENTBUY_ACCT=2"
if not exist "%~dp0.wallet2" (echo [x] Account 2 is not logged in. Open the panel and log in account 2 first. & exit /b 1)
set /p FOURBUY_WALLET=<"%~dp0.wallet2"
node "%~dp0%1.mjs" %2 %3 %4 %5 %6 %7 %8 %9
