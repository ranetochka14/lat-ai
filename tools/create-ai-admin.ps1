param([string]$PythonExe)
$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
if(-not $PythonExe){$PythonExe=Join-Path (Split-Path -Parent $projectDir) 'i02-venv/Scripts/python.exe'}
if(-not (Test-Path -LiteralPath $PythonExe)){throw 'Python environment missing. See README.'}
$PythonExe=(Resolve-Path -LiteralPath $PythonExe).Path
$env:PYTHONUTF8='1';$env:PYTHONNOUSERSITE='1'
$env:DJANGO_SETTINGS_MODULE='config.ai_local'
$env:LAT_AI_RUNTIME=Join-Path $projectDir '.runtime/i02'
Remove-Item Env:LAT_AI_TEST -ErrorAction SilentlyContinue
& $PythonExe (Join-Path $PSScriptRoot 'prepare-ai.py')
if($LASTEXITCODE -ne 0){throw 'Local database preparation failed. Existing data retained.'}
Write-Host 'Create your own local Django administrator. Enter email and password below.'
Write-Host 'The public review account is not an administrator.'
& $PythonExe (Join-Path $projectDir 'backend/manage.py') createsuperuser --settings=config.ai_local
if($LASTEXITCODE -ne 0){throw 'Administrator creation did not complete.'}
Write-Host 'Start LAT AI, then open http://127.0.0.1:8000/admin/ on this computer.'
