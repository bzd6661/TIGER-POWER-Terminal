@echo off
set "BINANCE_BAW_DIR=%~dp0.baw"
node --import "file:///%~dp0..\nokeytar.mjs" "%~dp0node_modules\@binance\agentic-wallet\dist\index.js" %*
