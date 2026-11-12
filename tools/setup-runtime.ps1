#requires -Version 5.1
<#
.SYNOPSIS
Prepare the local LAT AI Python and PostgreSQL runtimes after extracting the ZIP.
.DESCRIPTION
Downloads micromamba from the official mamba-org release and creates two isolated
conda-forge environments. Does not initialize a database, register a service,
activate a shell, create shortcuts, or change the system/user PATH.
.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\tools\setup-runtime.ps1
.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\tools\setup-runtime.ps1 -RuntimeDir "E:\LAT-runtime"
.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\tools\setup-runtime.ps1 -RuntimeDir "E:\LAT-runtime" -CheckOnly
#>
[CmdletBinding()]
param(
    [string]$RuntimeDir,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $projectRoot '.runtime'
}
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeDir)
$postgresPrefix = Join-Path $runtimeRoot 'postgres16'
$pythonPrefix = Join-Path $runtimeRoot 'python-env'
$postgresBin = Join-Path $postgresPrefix 'Library\bin'
$pythonExe = Join-Path $pythonPrefix 'python.exe'
$mambaExe = Join-Path $runtimeRoot 'micromamba.exe'
$mambaRoot = Join-Path $runtimeRoot 'mamba-root'
$requirementsFile = Join-Path $projectRoot 'backend\requirements.txt'
$constraintsFile = Join-Path $PSScriptRoot 'constraints-local.txt'
$dependencyStamp = Join-Path $pythonPrefix '.lat-ai-dependencies.json'
$archiveSitePackages = Join-Path $runtimeRoot 'archive-env\.venv\Lib\site-packages'

# These are the versions actually used to verify the local LAT AI backend.
$postgresVersion = '16.15'
$vectorVersion = '0.8.6'
$pythonVersion = '3.12.16'
$pipVersion = '26.2.2'
$mambaDownloadUrl = 'https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-win-64'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Step
    )
    Write-Host "`n$Step" -ForegroundColor Cyan
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed (exit code $LASTEXITCODE). See the command output above. No database was initialized."
    }
}

function Test-PostgresReady {
    foreach ($name in @('postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'psql.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $postgresBin $name) -PathType Leaf)) { return $false }
    }
    $vectorDll = Join-Path $postgresPrefix 'Library\lib\vector.dll'
    $vectorControl = Join-Path $postgresPrefix 'Library\share\extension\vector.control'
    $vectorSql = Join-Path $postgresPrefix "Library\share\extension\vector--$vectorVersion.sql"
    foreach ($file in @($vectorDll, $vectorControl, $vectorSql)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    }
    try {
        $reported = & (Join-Path $postgresBin 'postgres.exe') --version 2>&1
        if ($LASTEXITCODE -ne 0 -or ($reported -join ' ').Trim() -ne "postgres (PostgreSQL) $postgresVersion") { return $false }
        $control = Get-Content -LiteralPath $vectorControl -Raw
        return $control -match ("(?m)^default_version\s*=\s*'" + [regex]::Escape($vectorVersion) + "'\s*$")
    } catch { return $false }
}

function Test-PythonReady {
    if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) { return $false }
    try {
        $reported = & $pythonExe -B -c "import sys, ssl, sqlite3, bz2, lzma; print('.'.join(map(str, sys.version_info[:3])))" 2>&1
        if ($LASTEXITCODE -ne 0 -or ($reported -join ' ').Trim() -ne $pythonVersion) { return $false }
        $pipReported = & $pythonExe -B -m pip --version 2>&1
        return ($LASTEXITCODE -eq 0 -and ($pipReported -join ' ') -match '^pip\s+\S+\s+from\s+')
    } catch { return $false }
}

function Test-BackendImports {
    param([string]$ExtraPythonPath)
    $previousPythonPath = [Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process')
    try {
        if (-not [string]::IsNullOrWhiteSpace($ExtraPythonPath)) {
            $env:PYTHONPATH = $ExtraPythonPath
            if (-not [string]::IsNullOrWhiteSpace($previousPythonPath)) {
                $env:PYTHONPATH += [IO.Path]::PathSeparator + $previousPythonPath
            }
        }
        $importResult = & $pythonExe -B -c "import django, rest_framework, psycopg, sentence_transformers; print('LAT_DEPENDENCIES_OK')"
        return ($LASTEXITCODE -eq 0 -and ($importResult -join ' ') -match 'LAT_DEPENDENCIES_OK')
    } catch { return $false }
    finally { [Environment]::SetEnvironmentVariable('PYTHONPATH', $previousPythonPath, 'Process') }
}

function Test-BackendDependenciesReady {
    param(
        [Parameter(Mandatory = $true)][string]$RequirementsHash,
        [Parameter(Mandatory = $true)][string]$ConstraintsHash
    )
    if (-not (Test-Path -LiteralPath $dependencyStamp -PathType Leaf)) { return $false }
    try { $saved = Get-Content -LiteralPath $dependencyStamp -Raw | ConvertFrom-Json }
    catch { return $false }
    if (-not $saved.PSObject.Properties['requirements'] -or -not $saved.PSObject.Properties['constraints']) { return $false }
    if ($saved.requirements -ne $RequirementsHash -or $saved.constraints -ne $ConstraintsHash) { return $false }
    Write-Host 'Requirements and constraints are unchanged; checking installed backend modules...'
    return Test-BackendImports
}

function Install-LocalEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string[]]$Packages,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $operation = 'create'
    $repairArguments = @()
    if (Test-Path -LiteralPath (Join-Path $Prefix 'conda-meta\history') -PathType Leaf) {
        # Repair only package files in this managed prefix; never delete the directory.
        $operation = 'install'
        $repairArguments = @('--force-reinstall')
    } elseif ((Test-Path -LiteralPath $Prefix -PathType Container) -and
              @(Get-ChildItem -LiteralPath $Prefix -Force).Count -gt 0) {
        throw "Cannot create ${Label}: '$Prefix' is non-empty and is not a managed conda environment. Choose a different -RuntimeDir; existing files have not been removed."
    }
    $arguments = @(
        $operation,
        '--root-prefix', $mambaRoot,
        '--no-rc',
        '--prefix', $Prefix,
        '--channel', 'conda-forge',
        '--override-channels',
        '--skip-run-link-scripts',
        '--no-shortcuts',
        '--yes'
    ) + $repairArguments + $Packages
    Invoke-Checked -Executable $mambaExe -Arguments $arguments -Step "Prepare $Label in $Prefix"
}

$savedMambaRoot = [Environment]::GetEnvironmentVariable('MAMBA_ROOT_PREFIX', 'Process')
$savedMambaNoRc = [Environment]::GetEnvironmentVariable('MAMBA_NO_RC', 'Process')
$savedSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
$setupExitCode = 0

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
        throw 'This runtime setup supports 64-bit Windows only.'
    }
    if (-not (Test-Path -LiteralPath $requirementsFile -PathType Leaf)) {
        throw "Backend requirements were not found: $requirementsFile. Extract the complete LAT AI ZIP, including backend and tools."
    }
    if (-not (Test-Path -LiteralPath $constraintsFile -PathType Leaf)) {
        throw "Local compatibility constraints were not found: $constraintsFile. Extract the complete LAT AI ZIP."
    }

    Write-Host "LAT AI local runtime: $runtimeRoot"
    $postgresReady = Test-PostgresReady
    $pythonReady = Test-PythonReady
    Write-Host "PostgreSQL $postgresVersion / pgvector ${vectorVersion}: $postgresReady"
    Write-Host "Python $pythonVersion / pip: $pythonReady"

    if ($CheckOnly) {
        if (-not $postgresReady -or -not $pythonReady) {
            throw 'Runtime check failed. Run this script without -CheckOnly to prepare the missing environment. No files were changed by this check.'
        }
        Write-Host 'Runtime check passed. No packages were installed. Backend dependencies were not checked.' -ForegroundColor Green
    } else {
        [IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
        [IO.Directory]::CreateDirectory($mambaRoot) | Out-Null
        # Process-local settings only; restored in finally. No shell init or activation.
        $env:MAMBA_ROOT_PREFIX = $mambaRoot
        $env:MAMBA_NO_RC = 'true'
        [Net.ServicePointManager]::SecurityProtocol = $savedSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

        if (-not $postgresReady -or -not $pythonReady) {
            if (-not (Test-Path -LiteralPath $mambaExe -PathType Leaf)) {
                $downloadFile = Join-Path $runtimeRoot 'micromamba.download.exe'
                Write-Host "`nDownload official micromamba: $mambaDownloadUrl" -ForegroundColor Cyan
                try {
                    Invoke-WebRequest -Uri $mambaDownloadUrl -OutFile $downloadFile -UseBasicParsing -TimeoutSec 180
                    $stream = [IO.File]::OpenRead($downloadFile)
                    try {
                        if ($stream.Length -lt 100000 -or $stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) {
                            throw 'The download is not a Windows executable. Check the network/proxy response.'
                        }
                    } finally { $stream.Dispose() }
                    Invoke-Checked -Executable $downloadFile -Arguments @('--root-prefix', $mambaRoot, '--no-rc', '--version') -Step 'Verify downloaded micromamba'
                    Move-Item -LiteralPath $downloadFile -Destination $mambaExe
                } catch {
                    throw "Could not prepare micromamba from the official release: $($_.Exception.Message)"
                }
            }
            Invoke-Checked -Executable $mambaExe -Arguments @('--root-prefix', $mambaRoot, '--no-rc', '--version') -Step 'Verify local micromamba'
        }

        if ($postgresReady) {
            Write-Host 'PostgreSQL and pgvector are ready; environment creation skipped.'
        } else {
            Install-LocalEnvironment -Prefix $postgresPrefix -Packages @("postgresql=$postgresVersion", "pgvector=$vectorVersion") -Label 'PostgreSQL + pgvector'
            if (-not (Test-PostgresReady)) { throw "PostgreSQL verification failed after installation. Check '$postgresBin' and the vector extension files." }
        }

        if ($pythonReady) {
            Write-Host 'Python and pip are ready; environment creation skipped.'
        } else {
            Install-LocalEnvironment -Prefix $pythonPrefix -Packages @("python=$pythonVersion", "pip=$pipVersion") -Label 'Python + pip'
            if (-not (Test-PythonReady)) { throw "Python verification failed after installation: $pythonExe. SSL, SQLite, compression modules and pip must be available." }
        }

        $requirementsHash = (Get-FileHash -LiteralPath $requirementsFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $constraintsHash = (Get-FileHash -LiteralPath $constraintsFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if (Test-Path -LiteralPath $archiveSitePackages -PathType Container) {
            Write-Host "Checking backend dependencies from the supplied archive: $archiveSitePackages"
            if (-not (Test-BackendImports -ExtraPythonPath $archiveSitePackages)) {
                throw "The supplied backend archive dependencies failed the import check: '$archiveSitePackages'. Repair this extracted environment before continuing; no pip installation was attempted."
            }
            Write-Host 'Using dependencies from supplied backend archive'
            Write-Host 'Pip installation skipped. The archive was not checked against local constraints; no dependency stamp was written.'
        } elseif (Test-BackendDependenciesReady -RequirementsHash $requirementsHash -ConstraintsHash $constraintsHash) {
            Write-Host 'Backend requirements and constraints match the verified SHA256 stamp; pip installation skipped.'
        } else {
            Write-Host "`nInstall backend dependencies from: $requirementsFile"
            Write-Host 'The first installation includes machine-learning libraries and can take several minutes.'
            Invoke-Checked -Executable $pythonExe -Arguments @(
                '-m', 'pip', '--isolated', 'install',
                '--disable-pip-version-check', '--no-input', '--prefer-binary',
                '--cache-dir', (Join-Path $runtimeRoot 'pip-cache'),
                '-c', $constraintsFile,
                '-r', $requirementsFile
            ) -Step 'Install backend Python dependencies'
            Write-Host 'Verify Django, Django REST Framework, psycopg and sentence-transformers...'
            if (-not (Test-BackendImports)) {
                throw 'Backend import check failed after pip installation. The requirements stamp was not updated. Review the Python error above.'
            }
            $stamp = @{ requirements = $requirementsHash; constraints = $constraintsHash } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($dependencyStamp, $stamp + [Environment]::NewLine, [Text.Encoding]::ASCII)
        }

        Write-Host "`nRuntime ready." -ForegroundColor Green
        Write-Host "Python:     $pythonExe"
        Write-Host "PostgreSQL: $postgresBin"
        Write-Host 'No database has been initialized or started. No services, shortcuts, or global PATH entries were created.'
    }
} catch {
    Write-Error ("LAT AI runtime setup failed: " + $_.Exception.Message) -ErrorAction Continue
    $setupExitCode = 1
} finally {
    [Environment]::SetEnvironmentVariable('MAMBA_ROOT_PREFIX', $savedMambaRoot, 'Process')
    [Environment]::SetEnvironmentVariable('MAMBA_NO_RC', $savedMambaNoRc, 'Process')
    [Net.ServicePointManager]::SecurityProtocol = $savedSecurityProtocol
}

exit $setupExitCode
