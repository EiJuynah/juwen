@echo off
rem ============================================================================
rem  juwen launcher (Windows)
rem
rem  IMPORTANT - keep this file PURE ASCII.
rem  cmd.exe re-reads a batch file by byte offset while the code page is UTF-8;
rem  any multi-byte character inside the .cmd makes it lose its place, so comment
rem  lines get executed as commands ("'xxx' is not recognized..." spam) and later
rem  lines may be skipped. Chinese text is therefore printed by the Node server
rem  (which handles UTF-8 properly); everything in this file stays ASCII.
rem
rem  Behavior:
rem    1. APP_DIR   = directory of this launcher (after install:
rem                   %LOCALAPPDATA%\Programs\juwen).
rem    2. DATA_ROOT = %APPDATA%\juwen (falls back to %LOCALAPPDATA%\juwen).
rem                   First run creates <DATA_ROOT>\data and copies .env.example
rem                   to <DATA_ROOT>\.env. dotenv reads .env from the CURRENT
rem                   WORKING DIRECTORY, so we cd there before starting.
rem    3. Starts <APP_DIR>\server\index.js with <APP_DIR>\runtime\node.exe,
rem       falling back to "node" from PATH when the bundled runtime is missing.
rem
rem  NOTE: uninstalling does NOT delete the data directory (%APPDATA%\juwen);
rem        documents, comments and .env stay there.
rem ============================================================================
setlocal
chcp 65001 >nul

rem -- APP_DIR: strip the trailing backslash from %~dp0, but keep it for drive roots (D:\)
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if "%APP_DIR:~-1%"==":" set "APP_DIR=%APP_DIR%\"

rem -- DATA_ROOT
if not defined APPDATA goto :use_localappdata
if "%APPDATA%"=="" goto :use_localappdata
set "DATA_ROOT=%APPDATA%\juwen"
goto :data_root_ready
:use_localappdata
set "DATA_ROOT=%LOCALAPPDATA%\juwen"
:data_root_ready

rem -- port
if not defined PORT set "PORT=5178"

rem -- first run: data dir + config file (never overwrite an existing .env)
if not exist "%DATA_ROOT%" mkdir "%DATA_ROOT%" >nul 2>nul
if not exist "%DATA_ROOT%\data" mkdir "%DATA_ROOT%\data" >nul 2>nul
if not exist "%DATA_ROOT%\.env" if exist "%APP_DIR%\.env.example" copy /y "%APP_DIR%\.env.example" "%DATA_ROOT%\.env" >nul

rem -- bundled runtime, fall back to system node
set "NODE_EXE=%APP_DIR%\runtime\node.exe"
if not exist "%NODE_EXE%" (
  echo [juwen] bundled runtime not found, falling back to "node" from PATH
  set "NODE_EXE=node"
)

echo [juwen] app dir  : %APP_DIR%
echo [juwen] data dir : %DATA_ROOT%
echo [juwen] config   : %DATA_ROOT%\.env   ^(put your DEEPSEEK_API_KEY here^)
echo [juwen] open     : http://localhost:%PORT%
echo [juwen] press Ctrl+C or close this window to stop
echo.

rem -- open the browser after ~2s. ping is used as the delay because "timeout"
rem    fails on consoles without interactive input ("Input redirection is not
rem    supported"). Set JUWEN_NO_BROWSER=1 to skip (used by the packaging smoke test).
if not defined JUWEN_NO_BROWSER start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"

rem -- run the server with cwd = DATA_ROOT so .env is picked up from there
cd /d "%DATA_ROOT%"
set "DATA_DIR=%DATA_ROOT%\data"
"%NODE_EXE%" "%APP_DIR%\server\index.js"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [juwen] server stopped. If the log above says the port is in use, juwen is
  echo [juwen] probably already running - just open http://localhost:%PORT%
) else (
  echo [juwen] server exited with code %EXIT_CODE%. Please send the log above to the developer.
)
echo [juwen] data dir (kept after uninstall): %DATA_ROOT%
pause
endlocal
