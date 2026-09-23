#requires -Version 5.1
<#
.SYNOPSIS
Packages an already-built Windows x64 GUI EXE using the system WebView2 runtime.
.EXAMPLE
.\scripts\package-windows.ps1 -ExePath .\src-tauri\target\release\capacity-planner.exe
.NOTES
Does not build, install, download, sign, elevate, or launch the application.
OutputRoot must be inside this workspace; reparse points are rejected. Each run
creates a new directory and never removes or overwrites an existing package.
With identical input bytes and repository state, the manifest and ZIP metadata
are stable. Byte-for-byte ZIP reproducibility also requires the same .NET ZIP
implementation. The recorded commit/dirty flag describes packaging-time source
state; it does not attest that the supplied EXE was built from that state.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This packager requires Windows.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$workspacePrefix = $workspace + [IO.Path]::DirectorySeparatorChar
function Assert-WorkspacePath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
    if (-not $absolute.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The path must be a child of the workspace.' }
    $cursor = $absolute
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not allowed in package paths.' }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($parent) { $parent.FullName } else { $null }
    }
    return $absolute
}
function Get-Sha256([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

$exe = Get-Item -LiteralPath (Assert-WorkspacePath $ExePath)
if ($exe.PSIsContainer) { throw 'ExePath must identify a file.' }
if (-not $OutputRoot) { $OutputRoot = Join-Path $workspace 'src-tauri\target\portable' }
$output = Assert-WorkspacePath $OutputRoot
if ((Test-Path -LiteralPath $output) -and -not (Get-Item -LiteralPath $output).PSIsContainer) { throw 'OutputRoot must be a directory.' }
$readmePath = Assert-WorkspacePath (Join-Path $workspace 'packaging\windows\README-PORTABLE.txt')
$checkerPath = Assert-WorkspacePath (Join-Path $PSScriptRoot 'check-windows-package.ps1')
$peInfo = & $checkerPath -ExePath $exe.FullName
$exeBytes = [IO.File]::ReadAllBytes($exe.FullName)
if ((Get-Sha256 $exeBytes) -cne $peInfo.sha256) { throw 'The EXE changed during validation; finish the build before packaging.' }
$readmeBytes = [IO.File]::ReadAllBytes($readmePath)
$config = Get-Content -LiteralPath (Join-Path $workspace 'src-tauri\tauri.conf.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Expected a valid application version in tauri.conf.json.' }
$sourceCommit = & git -C $workspace rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Cannot determine the source commit.' }
$status = @(& git -C $workspace status --porcelain=v1 --untracked-files=normal)
if ($LASTEXITCODE -ne 0) { throw 'Cannot determine the source working-tree state.' }
$manifest = [ordered]@{
    schemaVersion = 1
    appName = 'Capacity Planner'
    appVersion = $version
    platform = 'windows'
    architecture = 'x64'
    packageKind = 'portable-system-webview2'
    source = [ordered]@{ commit = [string]$sourceCommit; workingTreeDirty = ($status.Count -gt 0); evidence = 'repository-state-at-packaging-not-binary-attestation' }
    executable = [ordered]@{ peMachine = $peInfo.peMachine; subsystem = $peInfo.subsystem; executionLevel = $peInfo.executionLevel }
    webView2 = [ordered]@{ bundled = $false; prerequisite = 'system-installed-evergreen-runtime' }
    offlineCertification = 'not-established-by-packaging'
    files = @(
        [ordered]@{ name = 'capacity-planner.exe'; bytes = $exeBytes.LongLength; sha256 = $peInfo.sha256 },
        [ordered]@{ name = 'README-PORTABLE.txt'; bytes = $readmeBytes.LongLength; sha256 = (Get-Sha256 $readmeBytes) }
    )
}
$utf8 = [Text.UTF8Encoding]::new($false)
$manifestBytes = $utf8.GetBytes(($manifest | ConvertTo-Json -Depth 8) + "`n")
$safeVersion = $version.Replace('+', '_')
$packageName = 'Capacity-Planner-' + $safeVersion + '-windows-x64-system-webview2'
$runDirectory = Assert-WorkspacePath (Join-Path $output ($packageName + '-' + [Guid]::NewGuid().ToString('N')))
if (Test-Path -LiteralPath $runDirectory) { throw 'The unique output directory already exists.' }
$null = [IO.Directory]::CreateDirectory($runDirectory)
$archivePath = Assert-WorkspacePath (Join-Path $runDirectory ($packageName + '.zip'))
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fileStream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$zip = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    $payload = [ordered]@{ 'capacity-planner.exe' = $exeBytes; 'README-PORTABLE.txt' = $readmeBytes; 'manifest.json' = $manifestBytes }
    foreach ($name in $payload.Keys) {
        $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $stream = $entry.Open()
        try { $stream.Write($payload[$name], 0, $payload[$name].Length) }
        finally { $stream.Dispose() }
    }
} finally { $zip.Dispose(); $fileStream.Dispose() }
$zipHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecarPath = Assert-WorkspacePath ($archivePath + '.sha256')
$sidecarBytes = $utf8.GetBytes($zipHash + '  ' + [IO.Path]::GetFileName($archivePath) + "`n")
$sidecarStream = [IO.File]::Open($sidecarPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $sidecarStream.Write($sidecarBytes, 0, $sidecarBytes.Length) }
finally { $sidecarStream.Dispose() }
& $checkerPath -ArchivePath $archivePath
