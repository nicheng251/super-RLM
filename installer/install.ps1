#requires -Version 5.1
<#
.SYNOPSIS
Install, upgrade, or uninstall super-RLM for the current Windows user.

.DESCRIPTION
Per-user installer for the super-RLM ZIP release. It installs under
%LOCALAPPDATA%\Programs\super-RLM by default, verifies SHA256SUMS, installs
Node dependencies with npm ci, keeps versioned directories, switches the
"current" entry, writes a bin\super-rlm.cmd shim, and adds that bin directory
to the user PATH (opt out with -NoPath).

No administrator rights are required. Node.js >= 22.19 must already be
installed; Node is checked but never bundled.

.PARAMETER Source
Release package root (the directory containing version.json). Defaults to the
parent of the installer directory.

.PARAMETER InstallDir
Install root. Defaults to %LOCALAPPDATA%\Programs\super-RLM.

.PARAMETER NoPath
Do not add <InstallDir>\bin to the user PATH. Also skips PATH removal during
uninstall.

.PARAMETER Uninstall
Remove the installation. Project data is kept unless -PurgeData is passed.

.PARAMETER PurgeData
With -Uninstall, also remove %USERPROFILE%\.super-rlm (project homes,
workspaces, sessions, and local secrets).

.PARAMETER Force
Reinstall the same version even when it is already installed.

.PARAMETER LogPath
Optional path for a plain-text installer log. The log contains no secrets.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\install.ps1

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\install.ps1 -WhatIf

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\install.ps1 -Uninstall -PurgeData
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$Source,
    [string]$InstallDir,
    [switch]$NoPath,
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$Force,
    [string]$LogPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\super-RLM'
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')

if ($PurgeData -and -not $Uninstall) {
    throw "-PurgeData can only be used together with -Uninstall."
}

$script:LogPath = $null
if ($LogPath) {
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would write the installer log to $LogPath"
    } else {
        $LogPath = [System.IO.Path]::GetFullPath($LogPath)
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $LogPath))
        $script:LogPath = $LogPath
    }
}

$script:NodeExe = $null
$script:NpmExe = $null
$script:NodeVersion = $null

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "[{0}] {1,-5} {2}" -f (Get-Date).ToString('HH:mm:ss'), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
    if ($script:LogPath) {
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
    }
}

function Get-NodeExe {
    if ($script:NodeExe) { return $script:NodeExe }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) {
        $command = Get-Command node -ErrorAction SilentlyContinue
    }
    if ($command) { $script:NodeExe = $command.Source }
    return $script:NodeExe
}

function Assert-WindowsX64 {
    if ($env:OS -ne 'Windows_NT') {
        throw "super-RLM requires Windows. This installer only supports Windows x64."
    }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') {
        throw "super-RLM requires 64-bit Windows on x64 (detected '$architecture')."
    }
    if (-not [System.Environment]::Is64BitOperatingSystem) {
        throw "super-RLM requires a 64-bit Windows installation."
    }
}

function Assert-Node {
    $node = Get-NodeExe
    if (-not $node) {
        throw "Node.js 22.19 or newer is required but 'node' was not found on PATH. Install Node.js from https://nodejs.org/ and run this installer again."
    }
    $rawVersion = ''
    try { $rawVersion = [string](& $node --version 2>$null) } catch { $rawVersion = '' }
    if ($LASTEXITCODE -ne 0 -or -not $rawVersion) {
        throw "Could not run Node.js at $node. Repair or reinstall Node.js 22.19 or newer."
    }
    $match = [regex]::Match($rawVersion, 'v?(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) {
        throw "Could not parse the Node.js version reported by $node ($rawVersion)."
    }
    $version = [version]("{0}.{1}.{2}" -f $match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value)
    if ($version -lt [version]'22.19.0') {
        throw "Node.js $rawVersion is too old. super-RLM requires Node.js 22.19 or newer."
    }
    $script:NodeVersion = $rawVersion.Trim()

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm.exe -ErrorAction SilentlyContinue }
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) {
        throw "npm was not found. Install the standard Node.js distribution (which includes npm) and run this installer again."
    }
    $script:NpmExe = $npm.Source
    Write-Log "Node.js $script:NodeVersion"
}

function Get-Sha256Hex {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $bytes = $sha.ComputeHash($stream)
        } finally {
            $stream.Dispose()
        }
        return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-PackageChecksums {
    param([string]$Root)
    $sumPath = Join-Path $Root 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $sumPath -PathType Leaf)) {
        throw "The release package is incomplete: SHA256SUMS is missing."
    }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $checked = 0
    foreach ($rawLine in (Get-Content -LiteralPath $sumPath)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $match = [regex]::Match($line, '^(?<hash>[0-9a-fA-F]{64})\s+\*?(?<path>.+)$')
        if (-not $match.Success) {
            throw "SHA256SUMS contains a malformed line: $line"
        }
        $relative = $match.Groups['path'].Value.Trim().Replace('/', '\')
        if ([System.IO.Path]::IsPathRooted($relative)) {
            throw "SHA256SUMS contains an absolute path: $relative"
        }
        $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $relative))
        if (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "SHA256SUMS path escapes the package: $relative"
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw "Package file is missing: $relative"
        }
        $actual = Get-Sha256Hex -Path $full
        if ($actual -ne $match.Groups['hash'].Value.ToLowerInvariant()) {
            throw "Checksum mismatch for $relative. The package may be corrupted or modified; download it again."
        }
        $checked++
        if ($checked % 100 -eq 0) { Write-Log "Verified $checked files..." }
    }
    if ($checked -eq 0) {
        throw "SHA256SUMS does not list any files."
    }
    Write-Log "Verified $checked package files." 'OK'
}

function Test-ReparsePoint {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Remove-DirectoryEntry {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (Test-ReparsePoint -Path $Path) {
        try {
            [System.IO.Directory]::Delete($Path, $false)
        } catch {
            throw "Could not remove the directory link $Path. Close programs using it and try again. $($_.Exception.Message)"
        }
    } else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Send-EnvironmentChange {
    try {
        if (-not ('SuperRlmEnvironmentBroadcast' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SuperRlmEnvironmentBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
        }
        $result = [UIntPtr]::Zero
        [void][SuperRlmEnvironmentBroadcast]::SendMessageTimeout(
            [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)
    } catch {
        Write-Log "Could not broadcast the environment change. Sign out and in, or open a new terminal." 'WARN'
    }
}

function Get-UserPathState {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    if ($null -eq $key) {
        return [pscustomobject]@{
            Value = ''
            Kind  = [Microsoft.Win32.RegistryValueKind]::ExpandString
        }
    }
    try {
        if (@($key.GetValueNames()) -contains 'Path') {
            $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            return [pscustomobject]@{ Value = $value; Kind = $key.GetValueKind('Path') }
        }
        return [pscustomobject]@{
            Value = ''
            Kind  = [Microsoft.Win32.RegistryValueKind]::ExpandString
        }
    } finally {
        $key.Dispose()
    }
}

function Set-UserPathState {
    param([string]$Value, [Microsoft.Win32.RegistryValueKind]$Kind)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $key.SetValue('Path', $Value, $Kind)
    } finally {
        $key.Dispose()
    }
}

function Add-UserPathEntry {
    param([string]$Entry)
    $entryNormalized = $Entry.TrimEnd('\')
    $state = Get-UserPathState
    $parts = @()
    if ($state.Value) {
        $parts = @($state.Value -split ';' | Where-Object { $_ -ne '' })
    }
    foreach ($part in $parts) {
        if ($part.TrimEnd('\') -ieq $entryNormalized) {
            Write-Log "User PATH already contains $Entry."
            return
        }
    }
    $parts += $Entry
    Set-UserPathState -Value ($parts -join ';') -Kind $state.Kind
    Send-EnvironmentChange
    Write-Log "Added to the user PATH: $Entry"
}

function Remove-UserPathEntry {
    param([string]$Entry)
    $entryNormalized = $Entry.TrimEnd('\')
    $state = Get-UserPathState
    if (-not $state.Value) {
        Write-Log "User PATH is empty; nothing to remove."
        return
    }
    $parts = @($state.Value -split ';' | Where-Object { $_ -ne '' })
    $kept = @($parts | Where-Object { $_.TrimEnd('\') -ine $entryNormalized })
    if ($kept.Count -eq $parts.Count) {
        Write-Log "User PATH does not contain $Entry."
        return
    }
    Set-UserPathState -Value ($kept -join ';') -Kind $state.Kind
    Send-EnvironmentChange
    Write-Log "Removed from the user PATH: $Entry"
}

function Get-InstalledVersion {
    $versionFile = Join-Path $InstallDir 'current\version.json'
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { return $null }
    try {
        $data = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
        if ($data.PSObject.Properties['version']) { return [string]$data.version }
    } catch {
        Write-Log "Could not read the installed version: $($_.Exception.Message)" 'WARN'
    }
    return $null
}

function Invoke-ExistingCli {
    param([string[]]$CliArguments)
    $entry = Join-Path $InstallDir 'current\apps\cli\src\main.ts'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { return $null }
    $node = Get-NodeExe
    if (-not $node) { return $null }
    $output = & $node --preserve-symlinks-main $entry @CliArguments 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
}

function Test-StackRunning {
    $result = Invoke-ExistingCli -CliArguments @('status')
    if ($null -eq $result) { return $false }
    if ($result.ExitCode -ne 0) {
        Write-Log "Could not check whether super-RLM is running (exit $($result.ExitCode)); assuming it is stopped." 'WARN'
        return $false
    }
    return [bool]($result.Output -match '(?m)^\s*(orchestrator|worker|supervisor|daemon)\s+(healthy|running)\b')
}

function Stop-ExistingStack {
    $result = Invoke-ExistingCli -CliArguments @('down')
    if ($null -eq $result) {
        Write-Log "No installed super-RLM CLI found; skipping stack shutdown."
        return
    }
    Write-Log "Stopping any running super-RLM stack..."
    foreach ($line in ($result.Output -split "`r?`n")) {
        if ($line.Trim()) { Write-Log ("  " + $line.Trim()) }
    }
    if ($result.ExitCode -ne 0) {
        Write-Log "Stack shutdown reported exit code $($result.ExitCode); continuing." 'WARN'
    }
}

function Copy-PackageTree {
    param([string]$SourceRoot, [string]$Destination)
    [void][System.IO.Directory]::CreateDirectory($Destination)
    foreach ($item in Get-ChildItem -LiteralPath $SourceRoot -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
    }
}

function Install-NodeDeps {
    param([string]$VersionRoot)
    $targets = @('runtime\pi', 'apps\cli', 'apps\orchestrator', 'apps\router', 'apps\tui')
    foreach ($relative in $targets) {
        $directory = Join-Path $VersionRoot $relative
        $lockFile = Join-Path $directory 'package-lock.json'
        if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
            if ($relative -eq 'runtime\pi') {
                throw "The release package is missing runtime\pi\package-lock.json."
            }
            Write-Log "Skipping npm ci for $relative (no package-lock.json)." 'WARN'
            continue
        }
        Write-Log "npm ci --prefix $relative"
        & $script:NpmExe ci --prefix $directory --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed for $relative (exit code $LASTEXITCODE)."
        }
    }

    $piCli = Join-Path $VersionRoot 'runtime\pi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
    if (-not (Test-Path -LiteralPath $piCli -PathType Leaf)) {
        throw "The Pi runtime was not installed correctly (missing $piCli)."
    }
    $yamlModule = Join-Path $VersionRoot 'apps\cli\node_modules\yaml'
    if (-not (Test-Path -LiteralPath $yamlModule -PathType Container)) {
        throw "The CLI dependency 'yaml' was not installed correctly (missing $yamlModule)."
    }
    Write-Log "Node dependencies installed." 'OK'
}

function Install-WorkerVenv {
    param([string]$VersionRoot, [string]$UvExe)
    $workerDir = Join-Path $VersionRoot 'apps\worker'
    $venvDir = Join-Path $workerDir '.venv'
    $workerPython = Join-Path $venvDir 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $workerDir 'pyproject.toml') -PathType Leaf)) {
        throw "The release package is missing apps\worker\pyproject.toml."
    }
    Write-Log "uv venv --python 3.11 apps\worker\.venv"
    & $UvExe venv --python 3.11 --allow-existing $venvDir
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed for apps\worker (exit code $LASTEXITCODE)." }
    Write-Log "uv pip install -e apps\worker"
    & $UvExe pip install --python $workerPython -e $workerDir
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed for apps\worker (exit code $LASTEXITCODE)." }
    $probe = & $workerPython -c "import super_rlm_worker" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Worker import check failed: $($probe.Trim())"
    }
    Write-Log "Worker venv installed." 'OK'
}

function Write-Shim {
    param([string]$BinDir)
    [void][System.IO.Directory]::CreateDirectory($BinDir)
    $shimPath = Join-Path $BinDir 'super-rlm.cmd'
    $content = @'
@echo off
setlocal
set "SUPER_RLM_ROOT=%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo super-rlm: Node.js 22.19 or newer is required but was not found on PATH. 1>&2
  echo Install Node.js from https://nodejs.org/ and open a new terminal. 1>&2
  exit /b 1
)
node --preserve-symlinks-main "%SUPER_RLM_ROOT%\current\apps\cli\src\main.ts" %*
'@
    $normalized = ($content -replace "`r`n", "`n") -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($shimPath, $normalized, (New-Object System.Text.UTF8Encoding($false)))
    Write-Log "Wrote shim: $shimPath"
}

function New-CurrentEntry {
    param([string]$VersionDir, [string]$EntryPath)
    try {
        New-Item -ItemType Junction -Path $EntryPath -Target $VersionDir -ErrorAction Stop | Out-Null
        return 'junction'
    } catch {
        Write-Log "Could not create a directory junction ($($_.Exception.Message)); falling back to a copy." 'WARN'
        if (Test-Path -LiteralPath $EntryPath) { Remove-DirectoryEntry -Path $EntryPath }
        Copy-Item -LiteralPath $VersionDir -Destination $EntryPath -Recurse -Force
        return 'copy'
    }
}

function Switch-Current {
    param([string]$InstallRoot, [string]$VersionRoot, [string]$ExpectedVersion)
    $current = Join-Path $InstallRoot 'current'
    $next = Join-Path $InstallRoot ('current.next.' + [guid]::NewGuid().ToString('N'))
    $backup = $null
    $backupName = $null

    try {
        New-CurrentEntry -VersionDir $VersionRoot -EntryPath $next | Out-Null
    } catch {
        if (Test-Path -LiteralPath $next) { Remove-DirectoryEntry -Path $next }
        throw
    }
    try {
        if (Test-Path -LiteralPath $current) {
            $backupName = 'current.old.' + [guid]::NewGuid().ToString('N')
            $backup = Join-Path $InstallRoot $backupName
            Rename-Item -LiteralPath $current -NewName $backupName
            Write-Log "Renamed the previous current entry to $backupName."
        }
        Rename-Item -LiteralPath $next -NewName 'current'
    } catch {
        if (Test-Path -LiteralPath $next) { Remove-DirectoryEntry -Path $next }
        if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $current)) {
            Rename-Item -LiteralPath $backup -NewName 'current'
        }
        throw
    }

    try {
        $entry = Join-Path $current 'apps\cli\src\main.ts'
        $output = & $script:NodeExe --preserve-symlinks-main $entry --version 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "the CLI exited with code $LASTEXITCODE. $($output.Trim())"
        }
        if ($output -notmatch [regex]::Escape($ExpectedVersion)) {
            throw "the CLI reported '$($output.Trim())' instead of $ExpectedVersion."
        }
        Write-Log "Post-install check: super-rlm $ExpectedVersion is runnable." 'OK'
    } catch {
        Remove-DirectoryEntry -Path $current
        if ($backup -and (Test-Path -LiteralPath $backup)) {
            Rename-Item -LiteralPath $backup -NewName 'current'
            Write-Log "Rolled current back to the previous installation." 'WARN'
        }
        throw "Post-install verification failed: $($_.Exception.Message)"
    }

    if ($backup -and (Test-Path -LiteralPath $backup)) {
        Remove-DirectoryEntry -Path $backup
    }
}

if ($Uninstall) {
    Write-Log "Uninstall requested for $InstallDir"
    if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
        Write-Log "super-RLM is not installed at $InstallDir." 'WARN'
        return
    }
    if (-not $PSCmdlet.ShouldProcess($InstallDir, 'Uninstall super-RLM')) { return }

    Stop-ExistingStack

    if (-not $NoPath) {
        Remove-UserPathEntry -Entry (Join-Path $InstallDir 'bin')
    }

    if ($PurgeData) {
        $dataDir = Join-Path $env:USERPROFILE '.super-rlm'
        if (Test-Path -LiteralPath $dataDir) {
            Remove-Item -LiteralPath $dataDir -Recurse -Force
            Write-Log "Removed project data: $dataDir"
        } else {
            Write-Log "No project data found at $dataDir"
        }
    } else {
        Write-Log "Project data was kept at $(Join-Path $env:USERPROFILE '.super-rlm'). Use -PurgeData to remove it."
    }

    $current = Join-Path $InstallDir 'current'
    if (Test-Path -LiteralPath $current) { Remove-DirectoryEntry -Path $current }
    foreach ($sub in @('versions', 'bin')) {
        $path = Join-Path $InstallDir $sub
        if (Test-Path -LiteralPath $path) { Remove-DirectoryEntry -Path $path }
    }
    foreach ($leftover in @(Get-ChildItem -LiteralPath $InstallDir -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'current.old.*' -or $_.Name -like 'current.next.*' })) {
        Remove-DirectoryEntry -Path $leftover.FullName
    }
    $remaining = @(Get-ChildItem -LiteralPath $InstallDir -Force)
    if ($remaining.Count -eq 0) {
        Remove-Item -LiteralPath $InstallDir -Force
        Write-Log "Removed $InstallDir"
    } else {
        Write-Log "Left unexpected files in $InstallDir (remove them manually if unwanted)." 'WARN'
    }
    Write-Log "super-RLM was uninstalled." 'OK'
    return
}

Assert-WindowsX64
Assert-Node

if (-not $Source) {
    $Source = Split-Path -Parent $PSScriptRoot
}
$SourceRoot = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "Release package directory not found: $SourceRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'version.json') -PathType Leaf)) {
    throw "This is not a super-RLM release package: version.json is missing from $SourceRoot."
}
if ($SourceRoot -ieq $InstallDir -or $SourceRoot.StartsWith($InstallDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The release package must not be inside the install directory."
}

$metadata = Get-Content -LiteralPath (Join-Path $SourceRoot 'version.json') -Raw | ConvertFrom-Json
if (-not $metadata.PSObject.Properties['version']) {
    throw "version.json does not contain a version."
}
$PackageVersion = [string]$metadata.version
if ($PackageVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Unsupported package version '$PackageVersion'."
}

$currentVersion = Get-InstalledVersion
$isUpgrade = $false
$isReinstall = $false
if ($currentVersion) {
    if ($currentVersion -eq $PackageVersion) { $isReinstall = $true } else { $isUpgrade = $true }
}
if ($isUpgrade) {
    $mode = "Upgrade $currentVersion -> $PackageVersion"
} elseif ($isReinstall) {
    $mode = "Reinstall $PackageVersion"
} else {
    $mode = "Install $PackageVersion"
}

Write-Log "$mode"
Write-Log "  package: $SourceRoot"
Write-Log "  target:  $InstallDir"
if ($NoPath) {
    Write-Log "  PATH:    unchanged (-NoPath)"
} else {
    Write-Log "  PATH:    add $(Join-Path $InstallDir 'bin') to the user PATH"
}

Test-PackageChecksums -Root $SourceRoot

if (-not $PSCmdlet.ShouldProcess($InstallDir, $mode)) { return }

if ($isReinstall -and -not $Force) {
    Write-Log "super-RLM $PackageVersion is already installed. Use -Force to reinstall." 'OK'
    if (-not $NoPath) { Add-UserPathEntry -Entry (Join-Path $InstallDir 'bin') }
    return
}

if ($currentVersion -and (Test-StackRunning)) {
    throw "super-RLM is running. Run 'super-rlm down', wait for it to exit, then run this installer again."
}

$versionsDir = Join-Path $InstallDir 'versions'
$versionDir = Join-Path $versionsDir $PackageVersion
$binDir = Join-Path $InstallDir 'bin'
[void][System.IO.Directory]::CreateDirectory($versionsDir)
[void][System.IO.Directory]::CreateDirectory($binDir)

$backupDir = $null
$switched = $false
try {
    if (Test-Path -LiteralPath $versionDir) {
        $backupName = "$PackageVersion.old." + [guid]::NewGuid().ToString('N')
        $backupDir = Join-Path $versionsDir $backupName
        Rename-Item -LiteralPath $versionDir -NewName $backupName
        Write-Log "Moved the existing versions\$PackageVersion aside for reinstall."
    }

    [void][System.IO.Directory]::CreateDirectory($versionDir)
    Write-Log "Copying package files to $versionDir"
    Copy-PackageTree -SourceRoot $SourceRoot -Destination $versionDir

    $uvExe = Join-Path $versionDir 'runtime\bin\uv.exe'
    if (-not (Test-Path -LiteralPath $uvExe -PathType Leaf)) {
        throw "The release package is missing runtime\bin\uv.exe."
    }
    try { Unblock-File -LiteralPath $uvExe -ErrorAction SilentlyContinue } catch { }
    $uvOutput = & $uvExe --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "The bundled uv.exe could not run. $($uvOutput.Trim())"
    }
    Write-Log "Bundled uv: $($uvOutput.Trim())"

    $primeAgent = Join-Path $versionDir 'runtime\prime-agent\prime-agent.exe'
    if (Test-Path -LiteralPath $primeAgent -PathType Leaf) {
        try { Unblock-File -LiteralPath $primeAgent -ErrorAction SilentlyContinue } catch { }
    } else {
        Write-Log "Prime Agent binary is not present in this package. First-run setup may report it as missing." 'WARN'
    }

    Install-NodeDeps -VersionRoot $versionDir
    Install-WorkerVenv -VersionRoot $versionDir -UvExe $uvExe
    Write-Shim -BinDir $binDir
    Switch-Current -InstallRoot $InstallDir -VersionRoot $versionDir -ExpectedVersion $PackageVersion
    $switched = $true
} catch {
    Write-Log "Install failed: $($_.Exception.Message)" 'ERROR'
    if (-not $switched) {
        if (Test-Path -LiteralPath $versionDir) {
            try { Remove-DirectoryEntry -Path $versionDir } catch {
                Write-Log "Could not remove the partial install at $versionDir" 'WARN'
            }
        }
        if ($backupDir -and (Test-Path -LiteralPath $backupDir)) {
            try {
                Rename-Item -LiteralPath $backupDir -NewName $PackageVersion
                Write-Log "Restored the previous versions\$PackageVersion directory." 'WARN'
            } catch {
                Write-Log "Could not restore the previous version directory at $backupDir" 'ERROR'
            }
        }
    }
    throw
}

if ($backupDir -and (Test-Path -LiteralPath $backupDir)) {
    try { Remove-DirectoryEntry -Path $backupDir } catch {
        Write-Log "Could not remove the old version directory $backupDir" 'WARN'
    }
}

if (-not $NoPath) {
    Add-UserPathEntry -Entry $binDir
}

Write-Log "super-RLM $PackageVersion installed at $InstallDir" 'OK'
if ($isUpgrade) {
    Write-Log "Previous version $currentVersion was kept under $versionsDir."
}
if ($NoPath) {
    Write-Log "The user PATH was not changed. Run: & '$binDir\super-rlm.cmd' setup"
} else {
    Write-Log "Open a new terminal so PATH changes apply, then run: super-rlm setup"
}
Write-Log "After setup, start the UI with: super-rlm"
