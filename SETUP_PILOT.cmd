@echo off
cd /d "%~dp0"
set "PYTHONUTF8=1"
if not exist ".venv\Scripts\python.exe" py -3.12 -m venv .venv
if errorlevel 1 goto :failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto :failed
call npm --prefix integration\ai ci --ignore-scripts
if errorlevel 1 goto :failed
echo Setup complete. Start LM Studio local server, then START_MAIN.cmd.
pause
exit /b 0
:failed
echo Setup failed. See docs/README-MAIN.txt. No model files were downloaded.
pause
exit /b 1
