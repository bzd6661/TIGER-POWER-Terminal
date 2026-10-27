@echo off
rem 全局 npm 目录:默认在 %APPDATA%\npm\node_modules,找不到才跑 npm root -g(慢)
set "NPMROOT=%APPDATA%\npm\node_modules"
if not exist "%NPMROOT%\@gangfun\cli\src\index.js" for /f "delims=" %%i in ('npm root -g') do set "NPMROOT=%%i"
node --import "file:///%~dp0baw-shim.mjs" "%NPMROOT%\@gangfun\cli\src\index.js" %*
