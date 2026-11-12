param([switch]$WithoutModel, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
# Local deployment paths are deliberately outside distributable source.
$configPath = Join-Path $root '.runtime/main-local.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json } else { $null }
if (Test-Path -LiteralPath $configPath) {
    if ($config -isnot [System.Management.Automation.PSCustomObject]) { throw 'main-local.json must be a configuration object; refusing fallback.' }
    foreach ($field in @('runtime', 'python', 'node')) {
        if ($config.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($config.$field)) {
            throw "main-local.json requires a nonempty $field path; refusing fallback."
        }
    }
}
$pythonExe = if ($config -and $config.python) { $config.python } else { Join-Path $root '.venv/Scripts/python.exe' }
$runtimeDir = if ($config -and $config.runtime) { $config.runtime } else { Join-Path $root '.runtime/i02' }
$nodeExe = if ($config -and $config.node) { $config.node } else { (Get-Command node.exe -ErrorAction Stop).Source }
foreach ($binary in @($pythonExe, $nodeExe)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Runtime dependency missing: $binary. See docs/setup.md." }
}
if ($config -and $config.runtime -and -not (Test-Path -LiteralPath (Join-Path $runtimeDir 'django.sqlite3'))) {
    throw 'Configured existing database is missing. Refusing to create an empty replacement.'
}
$arguments = @('-B', 'tools/pilot.py', '--runtime', $runtimeDir, '--node', $nodeExe)
if ($config -and $config.python_extra_site) {
    if (-not (Test-Path -LiteralPath $config.python_extra_site -PathType Container)) { throw 'Configured parser dependencies missing.' }
    $arguments += @('--python-extra-site', $config.python_extra_site)
}
$env:PYTHONUTF8 = '1'
$env:PYTHONNOUSERSITE = '1'
# Existing LM Studio CLI only; do not download or import model weights.
$lmsDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.lmstudio/bin'
if (Test-Path -LiteralPath (Join-Path $lmsDir 'lms.exe')) { $env:PATH = $lmsDir + ';' + $env:PATH }
if ($CheckOnly) {
    Write-Output ('Source: ' + $root)
    Write-Output ('Database: ' + (Join-Path $runtimeDir 'django.sqlite3'))
    Write-Output ('Python: ' + $pythonExe)
    Write-Output ('Node: ' + $nodeExe)
    exit 0
}
if (-not $WithoutModel) { $arguments += '--enable-model' }
$arguments += 'run'
& $pythonExe @arguments
exit $LASTEXITCODE
