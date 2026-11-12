@echo off
cd /d "%~dp0..\.."
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\tools\start-local.ps1"
if errorlevel 1 pause
