#requires -Version 5.1
<#
.SYNOPSIS
Checks a Windows x64 EXE or the exact contents and hashes of a portable ZIP.
.EXAMPLE
.\scripts\check-windows-package.ps1 -ArchivePath .\path\Capacity-Planner.zip
.EXAMPLE
.\scripts\check-windows-package.ps1 -ExePath .\src-tauri\target\release\capacity-planner.exe
.NOTES
Read-only. Does not launch code from the EXE or extract ZIP entries to disk.
The SHA256 sidecar is required for archive checks. Hashes are integrity checks,
not publisher signatures or evidence that a binary came from a given commit.
#>
[CmdletBinding(DefaultParameterSetName = 'Archive')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Archive')][string]$ArchivePath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Exe')][string]$ExePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-PeInfo([byte[]]$Bytes) {
    function Assert-Range([long]$Offset, [long]$Length) {
        if ($Offset -lt 0 -or $Length -lt 0 -or $Offset -gt $Bytes.LongLength - $Length) { throw 'Truncated or invalid PE file.' }
    }
    function Read-U16([long]$Offset) { Assert-Range $Offset 2; return [BitConverter]::ToUInt16($Bytes, [int]$Offset) }
    function Read-U32([long]$Offset) { Assert-Range $Offset 4; return [BitConverter]::ToUInt32($Bytes, [int]$Offset) }
    if ((Read-U16 0) -ne 0x5A4D) { throw 'The EXE has no MZ header.' }
    $pe = [long](Read-U32 60)
    if ((Read-U32 $pe) -ne 0x4550) { throw 'The EXE has no PE signature.' }
    if ((Read-U16 ($pe + 4)) -ne 0x8664) { throw 'Only Windows x64 (AMD64) PE files are accepted.' }
    $sectionCount = Read-U16 ($pe + 6)
    if ($sectionCount -lt 1 -or $sectionCount -gt 96) { throw 'Invalid PE section count.' }
    $optionalSize = Read-U16 ($pe + 20)
    $optional = $pe + 24
    Assert-Range $optional $optionalSize
    if ($optionalSize -lt 144 -or (Read-U16 $optional) -ne 0x20B) { throw 'Expected a PE32+ optional header.' }
    if ((Read-U16 ($optional + 68)) -ne 2) { throw 'Expected Windows GUI subsystem (2); console/debug builds are not accepted.' }
    if ((Read-U32 ($optional + 108)) -lt 3) { throw 'The PE file has no resource directory.' }
    $resourceRva = [long](Read-U32 ($optional + 128))
    $resourceSize = [long](Read-U32 ($optional + 132))
    if ($resourceRva -eq 0 -or $resourceSize -lt 16) { throw 'The EXE has no embedded resources.' }
    $sections = @()
    for ($index = 0; $index -lt $sectionCount; $index++) {
        $section = $optional + $optionalSize + ($index * 40)
        Assert-Range $section 40
        $sections += [pscustomobject]@{
            Rva = [long](Read-U32 ($section + 12))
            Size = [long](Read-U32 ($section + 16))
            Offset = [long](Read-U32 ($section + 20))
        }
    }
    function Resolve-Rva([long]$Rva, [long]$Length) {
        foreach ($section in $sections) {
            $relative = $Rva - $section.Rva
            if ($relative -ge 0 -and $Length -ge 0 -and $relative -le $section.Size - $Length) {
                $offset = $section.Offset + $relative
                Assert-Range $offset $Length
                return $offset
            }
        }
        throw 'PE resource points outside raw section data.'
    }
    $resourceBase = Resolve-Rva $resourceRva $resourceSize
    function Read-ResourceDirectory([long]$Relative) {
        if ($Relative -lt 0 -or $Relative -gt $resourceSize - 16) { throw 'Invalid PE resource directory.' }
        $offset = $resourceBase + $Relative
        $count = [int](Read-U16 ($offset + 12)) + [int](Read-U16 ($offset + 14))
        if ($count -gt 4096 -or $Relative + 16 + ($count * 8) -gt $resourceSize) { throw 'Invalid PE resource entries.' }
        for ($entry = 0; $entry -lt $count; $entry++) {
            $name = Read-U32 ($offset + 16 + ($entry * 8))
            $target = Read-U32 ($offset + 20 + ($entry * 8))
            [pscustomobject]@{
                Id = if (($name -band 2147483648L) -eq 0) { [long]$name } else { -1L }
                IsDirectory = ($target -band 2147483648L) -ne 0
                Offset = [long]($target -band 2147483647L)
            }
        }
    }
    $manifestTypes = @(Read-ResourceDirectory 0 | Where-Object { $_.Id -eq 24 -and $_.IsDirectory })
    if ($manifestTypes.Count -ne 1) { throw 'Expected exactly one RT_MANIFEST resource type.' }
    $manifestIds = @(Read-ResourceDirectory $manifestTypes[0].Offset | Where-Object { $_.Id -eq 1 -and $_.IsDirectory })
    if ($manifestIds.Count -ne 1) { throw 'Expected application manifest resource ID 1.' }
    $languages = @(Read-ResourceDirectory $manifestIds[0].Offset)
    if ($languages.Count -eq 0) { throw 'The application manifest has no language resource.' }
    foreach ($language in $languages) {
        if ($language.IsDirectory -or $language.Offset -gt $resourceSize - 16) { throw 'Invalid manifest resource leaf.' }
        $leaf = $resourceBase + $language.Offset
        $manifestLength = [long](Read-U32 ($leaf + 4))
        if ($manifestLength -lt 1 -or $manifestLength -gt 1048576) { throw 'Unexpected embedded manifest size.' }
        $manifestOffset = Resolve-Rva (Read-U32 $leaf) $manifestLength
        $stream = [IO.MemoryStream]::new($Bytes, [int]$manifestOffset, [int]$manifestLength, $false)
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $reader = [Xml.XmlReader]::Create($stream, $settings)
        try {
            $xml = [Xml.XmlDocument]::new()
            $xml.XmlResolver = $null
            $xml.Load($reader)
            $levels = $xml.SelectNodes("//*[local-name()='requestedExecutionLevel']")
            if ($levels.Count -ne 1 -or $levels[0].GetAttribute('level') -cne 'asInvoker' -or $levels[0].GetAttribute('uiAccess') -cne 'false') {
                throw 'The embedded manifest must request asInvoker with uiAccess=false.'
            }
        } finally { $reader.Dispose(); $stream.Dispose() }
    }
    return [pscustomobject]@{ architecture = 'x64'; peMachine = 'AMD64'; subsystem = 'Windows GUI'; executionLevel = 'asInvoker'; sha256 = (Get-Sha256 $Bytes) }
}

if ($PSCmdlet.ParameterSetName -eq 'Exe') {
    $exe = Get-Item -LiteralPath $ExePath
    if ($exe.PSIsContainer -or $exe.Length -gt 536870912) { throw 'Expected an EXE file no larger than 512 MiB.' }
    Get-PeInfo ([IO.File]::ReadAllBytes($exe.FullName))
    return
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveFile = Get-Item -LiteralPath $ArchivePath
if ($archiveFile.PSIsContainer -or $archiveFile.Length -gt 536870912) { throw 'Expected a ZIP file no larger than 512 MiB.' }
if ($archiveFile.Name -notmatch '^[A-Za-z0-9._-]+\.zip$') { throw 'Unexpected ZIP filename.' }
$zipHash = (Get-FileHash -LiteralPath $archiveFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecar = [IO.File]::ReadAllText($archiveFile.FullName + '.sha256').Trim()
if ($sidecar -cne ($zipHash + '  ' + $archiveFile.Name)) { throw 'ZIP SHA256 sidecar mismatch.' }
$archive = [IO.Compression.ZipFile]::OpenRead($archiveFile.FullName)
try {
    $expectedNames = @('capacity-planner.exe', 'README-PORTABLE.txt', 'manifest.json')
    $names = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($names.Count -ne 3 -or @($names | Select-Object -Unique).Count -ne 3) { throw 'ZIP must contain exactly three unique files.' }
    foreach ($name in $names) {
        if ($expectedNames -cnotcontains $name) { throw 'ZIP contains an unexpected entry or path.' }
    }
    $contents = @{}
    foreach ($entry in $archive.Entries) {
        $limit = if ($entry.FullName -ceq 'capacity-planner.exe') { 536870912L } elseif ($entry.FullName -ceq 'manifest.json') { 65536L } else { 262144L }
        if ($entry.Length -lt 1 -or $entry.Length -gt $limit) { throw 'Unexpected ZIP entry size.' }
        $inputStream = $entry.Open()
        $buffer = [IO.MemoryStream]::new()
        try { $inputStream.CopyTo($buffer); $contents[$entry.FullName] = $buffer.ToArray() }
        finally { $inputStream.Dispose(); $buffer.Dispose() }
    }
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $manifest = $utf8.GetString($contents['manifest.json']) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -cne 'x64' -or $manifest.platform -cne 'windows' -or $manifest.packageKind -cne 'portable-system-webview2') { throw 'Unsupported package manifest.' }
    if ($manifest.appVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid application version.' }
    if ($manifest.source.commit -notmatch '^[a-f0-9]{40}$' -or $manifest.source.workingTreeDirty -isnot [bool] -or $manifest.source.evidence -cne 'repository-state-at-packaging-not-binary-attestation') { throw 'Invalid source provenance.' }
    if ($manifest.webView2.bundled -ne $false -or $manifest.webView2.prerequisite -cne 'system-installed-evergreen-runtime' -or $manifest.offlineCertification -cne 'not-established-by-packaging') { throw 'Unsupported runtime or offline claims.' }
    if (@($manifest.files).Count -ne 2) { throw 'Expected EXE and README hashes in the manifest.' }
    $payloadNames = @()
    foreach ($file in $manifest.files) {
        if (@('capacity-planner.exe', 'README-PORTABLE.txt') -cnotcontains $file.name -or $payloadNames -ccontains $file.name) { throw 'Unexpected or duplicate manifest payload.' }
        $payloadNames += $file.name
        if ($file.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $file.sha256 -cne (Get-Sha256 $contents[$file.name]) -or $file.bytes -ne $contents[$file.name].LongLength) { throw 'Payload SHA256 or size mismatch.' }
    }
    $peInfo = Get-PeInfo $contents['capacity-planner.exe']
    if ($manifest.executable.subsystem -cne $peInfo.subsystem -or $manifest.executable.executionLevel -cne $peInfo.executionLevel -or $manifest.executable.peMachine -cne $peInfo.peMachine) { throw 'Manifest PE metadata does not match the embedded EXE.' }
    [pscustomobject]@{ verified = $true; archive = $archiveFile.FullName; sha256 = $zipHash; exeSha256 = $peInfo.sha256; appVersion = $manifest.appVersion; files = $expectedNames }
} finally { $archive.Dispose() }
