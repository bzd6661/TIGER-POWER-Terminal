@echo off
rem 账号 2 的 baw:放到 PATH 最前面,别的脚本调用 "baw" 就会用账号 2
set "BINANCE_BAW_DIR=%~dp0..\.baw"
node "%~dp0..\node_modules\@binance\agentic-wallet\dist\index.js" %*
