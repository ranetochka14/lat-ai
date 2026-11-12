@echo off
setlocal
cd /d "%~dp0..\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer and reopen this window.
  echo To preview the public page, open index.html directly in your browser.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Run: node server.cjs
  pause
  exit /b 1
)
echo Open http://localhost:5173 after the server is ready.
call npm.cmd start
pause

