param([string]$PythonExe, [switch]$NoBrowser, [switch]$EnableModel)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
if (-not $PythonExe) { $PythonExe = Join-Path (Split-Path -Parent $projectDir) 'i02-venv/Scripts/python.exe' }
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Python environment missing. See docs/ai/I02_2_RUN.md.' }
$PythonExe = (Resolve-Path -LiteralPath $PythonExe).Path
$runtimeDir = Join-Path $projectDir '.runtime/i02'
foreach ($port in @(5173,8000,8372)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Port $port is occupied. Existing process was not stopped." }
}
$env:PYTHONUTF8 = '1'
& $PythonExe (Join-Path $PSScriptRoot 'prepare-ai.py')
if ($LASTEXITCODE -ne 0) { throw 'AI profile preparation failed.' }
$env:DJANGO_SETTINGS_MODULE = 'config.ai_local'
$env:LAT_AI_RUNTIME = $runtimeDir
Remove-Item Env:LAT_AI_TEST -ErrorAction SilentlyContinue
$nodeExe = (Get-Command node.exe).Source
$workerProcess = Start-Process -FilePath $nodeExe -ArgumentList @('integration/ai/worker.mjs') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'worker.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'worker.stderr.log') -PassThru
$djangoProcess = Start-Process -FilePath $PythonExe -ArgumentList @('backend/manage.py','runserver','127.0.0.1:8000','--noreload') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'django.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'django.stderr.log') -PassThru
$siteProcess = Start-Process -FilePath $nodeExe -ArgumentList @('server.cjs') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'site.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'site.stderr.log') -PassThru
@{worker=$workerProcess.Id;django=$djangoProcess.Id;site=$siteProcess.Id;started=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'processes.json') -Encoding UTF8
$headers = @{'X-LAT-IPC'=(Get-Content -LiteralPath (Join-Path $runtimeDir 'ipc-secret.txt') -Raw).Trim()}
$ready = $false
for ($i=0;$i -lt 20;$i++) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:8372/health' -Headers $headers -TimeoutSec 2; $ready=$true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) { throw 'Worker did not start; see .runtime/i02 logs.' }
if ($EnableModel) {
    & lms server start
    if ($LASTEXITCODE -ne 0) { throw 'LM Studio server failed to start.' }
    $null = Invoke-RestMethod 'http://127.0.0.1:8372/control' -Method Post -ContentType 'application/json' -Headers $headers -Body '{"action":"enable"}' -TimeoutSec 150
}
Write-Host 'LAT AI manual review: http://127.0.0.1:5173/#/courses'
Write-Host 'Isolated adult test account: review@lat-ai.local / LatAI-Review-2026!'
Write-Host 'Model responses are unverified; hints are from the catalogue. No code execution.'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/#/courses' }
