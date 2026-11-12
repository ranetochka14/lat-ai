@echo off
cd /d "%~dp0"
set "PYTHONUTF8=1"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -B tools\pilot.py --enable-model run
) else if exist ".runtime\python\python.exe" (
  ".runtime\python\python.exe" -B tools\pilot.py --enable-model run
) else (
  echo Run SETUP_PILOT.cmd first. See docs/README-PILOT.txt.
)
pause
