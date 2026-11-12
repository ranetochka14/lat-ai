param([ValidateSet('status','enable','disable','retire')][string]$Action='status')
$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$secretPath=Join-Path $projectDir '.runtime/i02/ipc-secret.txt'
$headers=@{'X-LAT-IPC'=(Get-Content -LiteralPath $secretPath -Raw).Trim()}
if($Action -eq 'status') {
    $state=Invoke-RestMethod 'http://127.0.0.1:8372/health' -Headers $headers -TimeoutSec 3
} else {
    if($Action -eq 'enable') { & lms server start; if($LASTEXITCODE -ne 0){throw 'LM Studio server is unavailable'} }
    $state=Invoke-RestMethod 'http://127.0.0.1:8372/control' -Headers $headers -Method Post -ContentType 'application/json' -Body (@{action=$Action}|ConvertTo-Json -Compress) -TimeoutSec 150
}
$state | ConvertTo-Json -Depth 5
