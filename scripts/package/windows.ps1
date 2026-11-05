#requires -Version 5.1
<#
.SYNOPSIS
Stage and package a super-RLM Windows x64 release.

.DESCRIPTION
Builds a release directory and ZIP from the repository. The package contains
the application sources, runtime manifests, the bundled uv.exe, and the Prime
Agent binary/runtime/skills when they are present. It never contains .git,
.tmp, node_modules, .venv, __pycache__, tests, or user project data/secrets.

Node.js is a host prerequisite and is never bundled.

.PARAMETER UvPath
Path to the uv.exe that should be bundled at runtime/bin/uv.exe. Required.

.PARAMETER RepoRoot
Repository root. Defaults to the parent of scripts/package.

.PARAMETER OutputDir
Directory for the staged release and ZIP. Defaults to <repo>/dist.

.PARAMETER Version
Release version. Defaults to 0.1.0.

.PARAMETER DryRun
Print the staging plan and file counts without writing anything. Supports
-WhatIf as well.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package/windows.ps1 `
  -UvPath C:\Users\me\.local\bin\uv.exe

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package/windows.ps1 `
  -UvPath C:\Users\me\.local\bin\uv.exe -DryRun
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$UvPath,

    [string]$RepoRoot,
    [string]$OutputDir,
    [string]$Version = '0.1.0',
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

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

function Write-Step {
    param([string]$Message)
    Write-Host ("[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $Message)
}

function Test-ExcludedDirectory {
    param([string]$Name, [string]$RelativePath)
    if ($Name -in @('.git', '.tmp', 'node_modules', '.venv', '__pycache__', '.pytest_cache', 'dist', 'secrets')) {
        return $true
    }
    if ($Name -eq 'tests' -and ($RelativePath -match '^(apps|packages)[\\/]')) {
        return $true
    }
    return $false
}

function Test-ExcludedFile {
    param([string]$Name)
    if ($Name -in @('.super-rlm-project.json', '.env', '.DS_Store', 'Thumbs.db')) { return $true }
    if ($Name -like '.env.*') { return $true }
    if ($Name -like '*.pyc' -or $Name -like '*.pyo' -or $Name -like '*.log') { return $true }
    if ($Name -like '*.pem' -or $Name -like '*.key') { return $true }
    return $false
}

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'apps') -PathType Container)) {
    throw "Repository root not found or invalid: $RepoRoot"
}

if (-not $OutputDir) { $OutputDir = Join-Path $RepoRoot 'dist' }
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)

$Version = $Version.Trim()
if ($Version.StartsWith('v')) { $Version = $Version.Substring(1) }
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 0.1.0 (got '$Version')."
}

$Preview = $DryRun -or $WhatIfPreference
$ReleaseName = "super-rlm-v$Version-win-x64"
$StageDir = Join-Path $OutputDir $ReleaseName
$ZipPath = Join-Path $OutputDir "$ReleaseName.zip"

$UvSource = [System.IO.Path]::GetFullPath($UvPath)
if (-not (Test-Path -LiteralPath $UvSource -PathType Leaf)) {
    if ($Preview) {
        Write-Warning "uv.exe was not found at $UvSource. A real build requires it."
    } else {
        throw "uv.exe was not found at $UvSource. Pass -UvPath with a Windows x64 uv.exe."
    }
}

$Manifest = $null
$ManifestPath = Join-Path $RepoRoot 'runtime\manifest.json'
if (Test-Path -LiteralPath $ManifestPath) {
    try { $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json } catch { $Manifest = $null }
}

$script:SourceFiles = New-Object 'System.Collections.Generic.List[object]'
$script:SeenPaths = @{}
$script:RequiredMissing = New-Object 'System.Collections.Generic.List[string]'

function Add-SourceFile {
    param([string]$SourcePath, [string]$RelativePath, [bool]$Required = $true)
    $key = $RelativePath.ToLowerInvariant()
    if ($script:SeenPaths.ContainsKey($key)) { return }
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        if ($Required) { $script:RequiredMissing.Add($RelativePath) }
        return
    }
    $item = Get-Item -LiteralPath $SourcePath
    $script:SeenPaths[$key] = $true
    $script:SourceFiles.Add([pscustomobject]@{
        Source   = $SourcePath
        Relative = $RelativePath
        Size     = $item.Length
    })
}

function Add-SourceTree {
    param([string]$AbsoluteDir, [string]$RelativeDir)
    foreach ($item in Get-ChildItem -LiteralPath $AbsoluteDir -Force) {
        $relative = Join-Path $RelativeDir $item.Name
        if ($item.PSIsContainer) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                Write-Warning "Skipping reparse point: $relative"
                continue
            }
            if (Test-ExcludedDirectory -Name $item.Name -RelativePath $relative) { continue }
            Add-SourceTree -AbsoluteDir $item.FullName -RelativeDir $relative
        } else {
            if (Test-ExcludedFile -Name $item.Name) { continue }
            Add-SourceFile -SourcePath $item.FullName -RelativePath $relative
        }
    }
}

# Product trees.
foreach ($dir in @('apps', 'packages', 'config', 'scripts')) {
    $absolute = Join-Path $RepoRoot $dir
    if (Test-Path -LiteralPath $absolute -PathType Container) {
        Add-SourceTree -AbsoluteDir $absolute -RelativeDir $dir
    } else {
        Write-Warning "Missing expected source directory: $dir"
    }
}

# Runtime manifests and Pi dependency manifest (node_modules are installed by the installer).
foreach ($relative in @(
    'README.md',
    'runtime\manifest.json',
    'runtime\pi\package.json',
    'runtime\pi\package-lock.json',
    'installer\install.ps1',
    'installer\README.md'
)) {
    Add-SourceFile -SourcePath (Join-Path $RepoRoot $relative) -RelativePath $relative
}

# Minimal documentation.
foreach ($relative in @(
    'docs\README.md',
    'docs\architecture.md',
    'docs\guides\developing-with-super-rlm.md'
)) {
    Add-SourceFile -SourcePath (Join-Path $RepoRoot $relative) -RelativePath $relative -Required $false
}

# Prime Agent binary, runtime shim, and skills. Optional at build time, but included when present.
$PrimeRoot = Join-Path $RepoRoot 'runtime\prime-agent'
$PrimeIncluded = Test-Path -LiteralPath $PrimeRoot -PathType Container
if ($PrimeIncluded) {
    Add-SourceTree -AbsoluteDir $PrimeRoot -RelativeDir 'runtime\prime-agent'
} else {
    Write-Warning "runtime\prime-agent is missing; the package will not contain Prime Agent."
}
$PrimeBinary = Join-Path $PrimeRoot 'prime-agent.exe'
if (-not (Test-Path -LiteralPath $PrimeBinary -PathType Leaf)) {
    Write-Warning "runtime\prime-agent\prime-agent.exe is missing; the package will not contain the Prime Agent binary."
}

if ($script:RequiredMissing.Count -gt 0) {
    throw ("Required release files are missing:`n  " + ($script:RequiredMissing -join "`n  "))
}

$SortedFiles = $script:SourceFiles | Sort-Object Relative
$TotalBytes = 0L
foreach ($file in $SortedFiles) { $TotalBytes += [long]$file.Size }

$PiVersion = $null
$PrimeVersion = $null
$PrimeRuntimeVersion = $null
if ($null -ne $Manifest) {
    if ($Manifest.PSObject.Properties['pi']) { $PiVersion = [string]$Manifest.pi.version }
    if ($Manifest.PSObject.Properties['prime_agent']) {
        $PrimeVersion = [string]$Manifest.prime_agent.version
        $PrimeRuntimeVersion = [string]$Manifest.prime_agent.runtime_version
    }
}

Write-Step "Release plan"
Write-Step "  Version:   $Version"
Write-Step "  Source:    $RepoRoot"
Write-Step "  Stage:     $StageDir"
Write-Step "  ZIP:       $ZipPath"
Write-Step "  uv:        $UvSource"
Write-Step "  Prime:     $(if ($PrimeIncluded) { 'included' } else { 'missing' })"
Write-Step ("  Files:     {0} ({1:N1} MB)" -f $SortedFiles.Count, ($TotalBytes / 1MB))
$SortedFiles | Group-Object { ($_.Relative -split '\\')[0] } | Sort-Object Name | ForEach-Object {
    $groupBytes = 0L
    foreach ($entry in $_.Group) { $groupBytes += [long]$entry.Size }
    Write-Host ("             {0,-12} {1,5} files {2,8:N1} MB" -f $_.Name, $_.Count, ($groupBytes / 1MB))
}

if ($Preview) {
    Write-Step "Dry run: no files written."
    return
}

if (-not $PSCmdlet.ShouldProcess($StageDir, "Stage super-RLM $Version release")) { return }

# Stage.
if (Test-Path -LiteralPath $StageDir) {
    Remove-Item -LiteralPath $StageDir -Recurse -Force
}
[void][System.IO.Directory]::CreateDirectory($StageDir)

$copied = 0
foreach ($file in $SortedFiles) {
    $destination = Join-Path $StageDir $file.Relative
    [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
    Copy-Item -LiteralPath $file.Source -Destination $destination -Force
    $copied++
}
Write-Step "Copied $copied files."

# Bundle uv.exe.
$UvTarget = Join-Path $StageDir 'runtime\bin\uv.exe'
[void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $UvTarget))
Copy-Item -LiteralPath $UvSource -Destination $UvTarget -Force
try { Unblock-File -LiteralPath $UvTarget -ErrorAction SilentlyContinue } catch { }
Write-Step "Bundled uv.exe."

$UvVersion = $null
try {
    $uvOutput = (& $UvSource --version 2>&1 | Out-String).Trim()
} catch {
    throw "Could not run uv at $UvSource. Pass -UvPath with a working Windows x64 uv.exe. $($_.Exception.Message)"
}
if ($LASTEXITCODE -ne 0) {
    throw "uv at $UvSource exited with code $LASTEXITCODE."
}
if ($uvOutput -match 'uv\s+(\d+\.\d+\.\d+)') {
    $UvVersion = $Matches[1]
} else {
    Write-Warning "Could not parse the uv version from: $uvOutput"
}

# Unblock the Prime Agent binary when present.
if (Test-Path -LiteralPath (Join-Path $StageDir 'runtime\prime-agent\prime-agent.exe')) {
    try { Unblock-File -LiteralPath (Join-Path $StageDir 'runtime\prime-agent\prime-agent.exe') -ErrorAction SilentlyContinue } catch { }
}

$GitCommit = $null
$GitBranch = $null
if (Get-Command git -ErrorAction SilentlyContinue) {
    try {
        $GitCommit = (& git -C $RepoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
        $GitBranch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { $GitCommit = $null; $GitBranch = $null }
    } catch { $GitCommit = $null; $GitBranch = $null }
}

$PrimeBinaryIncluded = Test-Path -LiteralPath (Join-Path $StageDir 'runtime\prime-agent\prime-agent.exe') -PathType Leaf
$VersionObject = [ordered]@{
    name     = 'super-rlm'
    version  = $Version
    platform = 'win32-x64'
    builtAt  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    node     = '>=22.19.0'
    source   = [ordered]@{
        gitCommit = $GitCommit
        gitBranch = $GitBranch
    }
    components = [ordered]@{
        pi                 = $PiVersion
        primeAgent         = $PrimeVersion
        primeAgentRuntime  = $PrimeRuntimeVersion
        primeAgentIncluded = $PrimeBinaryIncluded
        uv                 = $UvVersion
    }
}
$VersionJson = $VersionObject | ConvertTo-Json -Depth 8
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $StageDir 'version.json'), $VersionJson + "`r`n", $Utf8NoBom)
Write-Step "Wrote version.json."

# Checksums for every staged file except SHA256SUMS itself.
$SumLines = New-Object 'System.Collections.Generic.List[string]'
$sumFiles = Get-ChildItem -LiteralPath $StageDir -Recurse -File -Force | Sort-Object FullName
foreach ($file in $sumFiles) {
    $relative = $file.FullName.Substring($StageDir.Length + 1).Replace('\', '/')
    $hash = Get-Sha256Hex -Path $file.FullName
    $SumLines.Add("$hash  $relative")
}
[System.IO.File]::WriteAllLines((Join-Path $StageDir 'SHA256SUMS'), $SumLines, $Utf8NoBom)
Write-Step ("Wrote SHA256SUMS for {0} files." -f $sumFiles.Count)

# ZIP.
if (-not $PSCmdlet.ShouldProcess($ZipPath, 'Create release ZIP')) { return }
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $StageDir,
    $ZipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)
$zipHash = Get-Sha256Hex -Path $ZipPath
[System.IO.File]::WriteAllText(
    "$ZipPath.sha256",
    "$zipHash  $ReleaseName.zip`r`n",
    $Utf8NoBom
)
$zipSize = (Get-Item -LiteralPath $ZipPath).Length
Write-Step ("Created {0} ({1:N1} MB)" -f $ZipPath, ($zipSize / 1MB))
Write-Step ("SHA256 {0}" -f $zipHash)
Write-Step "Done."
