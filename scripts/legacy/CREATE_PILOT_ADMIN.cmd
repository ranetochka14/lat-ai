@echo off
cd /d "%~dp0..\.."
set "PYTHONUTF8=1"
set "PILOT_PY=.runtime\python\python.exe"
if exist ".venv\Scripts\python.exe" set "PILOT_PY=.venv\Scripts\python.exe"
"%PILOT_PY%" -B tools\pilot.py prepare
if errorlevel 1 goto :end
"%PILOT_PY%" -B tools\pilot.py manage createsuperuser
:end
pause
