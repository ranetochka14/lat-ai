@echo off
cd /d "%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\start-ai-review.ps1 -EnableModel
pause
