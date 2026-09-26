#requires -Version 5.1
<#
.SYNOPSIS
Development-only network check of a released Windows ZIP (DEC-023, stage 4).
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\network-check-windows.ps1 -Tag v0.1.0
.NOTES
Artificial data only. The released EXE runs three times with test-only settings that are
passed to that process alone (WEBVIEW2_USER_DATA_FOLDER replaces the app profile folder,
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is appended to the app's own arguments):
  control - fresh profile; CSP is bypassed through CDP and the page POSTs a control marker to
            https://example.com. The summary must find it, otherwise the method is broken.
  fresh   - fresh profile; webview-smoke and report-export-smoke with marker data.
  warm    - the same profile again; webview-smoke with marker data.
NetLog runs in capture mode Everything with QUIC disabled (QUIC content cannot be read). All
logs stay under src-tauri\target; only summaries are printed. TCP connections of the whole
process tree are sampled once a second.
#>
[CmdletBinding()]
param(
    [string]$Tag = 'v0.1.0',
    [string]$ZipPath,
    [int]$Port = 19331
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This check requires Windows.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $workspace
$startedAt = Get-Date
$work = Join-Path $workspace ('src-tauri\target\network-check-' + $startedAt.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $work | Out-Null

# --- Release ZIP ------------------------------------------------------------------------
if (-not $ZipPath) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $version = $Tag.TrimStart('v')
    $name = "Capacity-Planner-$version-windows-x64-system-webview2.zip"
    $base = "https://github.com/Samoiloff90/capacity-manager/releases/download/$Tag"
    $ZipPath = Join-Path $work $name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $ZipPath
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.sha256" -OutFile "$ZipPath.sha256"
}
$expectedHash = ((Get-Content -LiteralPath "$ZipPath.sha256" -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipPath).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) { throw "SHA-256 of $ZipPath does not match its .sha256 file." }
$appDir = Join-Path $work 'app'
Expand-Archive -LiteralPath $ZipPath -DestinationPath $appDir
$exe = Join-Path $appDir 'capacity-planner.exe'

# --- Markers (ASCII and Cyrillic; built from code points to keep this file ASCII) -------------
$random = -join (1..6 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$asciiMarker = "zqxnet$random"
$cyrillicMarker = (-join ([char[]](0x043C, 0x0430, 0x0440, 0x043A, 0x0435, 0x0440, 0x0441, 0x0435, 0x0442, 0x0438))) + (Get-Random -Minimum 100000 -Maximum 999999)
$controlMarker = "zqxctl$random"
$allMarkers = "$asciiMarker,$cyrillicMarker,$controlMarker"

function Get-Tree([int]$RootId, [datetime]$Since) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)
    $ids = New-Object System.Collections.Generic.List[int]
    $ids.Add($RootId)
    for ($i = 0; $i -lt $ids.Count; $i++) {
        foreach ($child in $all) {
            if ($child.ParentProcessId -eq $ids[$i] -and $child.CreationDate -ge $Since -and -not $ids.Contains([int]$child.ProcessId)) {
                $ids.Add([int]$child.ProcessId)
            }
        }
    }
    return @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
}

function Start-App([string]$Run, [string]$ProfileDir) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is in use." }
    $netlog = Join-Path $work "netlog-$Run.json"
    $env:WEBVIEW2_USER_DATA_FOLDER = $ProfileDir
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --log-net-log=$netlog --net-log-capture-mode=Everything --disable-quic"
    try { $process = Start-Process -FilePath $exe -PassThru }
    finally { Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER, Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
    $since = $process.StartTime.AddSeconds(-1)
    $stopFile = Join-Path $work "stop-$Run"
    $socketsCsv = Join-Path $work "sockets-$Run.csv"
    $sampler = Start-Job -ArgumentList $process.Id, $since, $socketsCsv, $stopFile -ScriptBlock {
        param([int]$RootId, [datetime]$Since, [string]$Csv, [string]$StopFile)
        'time,pid,process,remote,state' | Set-Content -Encoding UTF8 -LiteralPath $Csv
        while (-not (Test-Path -LiteralPath $StopFile)) {
            $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate)
            $ids = New-Object System.Collections.Generic.List[int]
            $ids.Add($RootId)
            for ($i = 0; $i -lt $ids.Count; $i++) {
                foreach ($child in $all) {
                    if ($child.ParentProcessId -eq $ids[$i] -and $child.CreationDate -ge $Since -and -not $ids.Contains([int]$child.ProcessId)) { $ids.Add([int]$child.ProcessId) }
                }
            }
            $names = @{}
            foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $names[[int]$p.ProcessId] = $p.Name } }
            $now = (Get-Date).ToString('o')
            foreach ($c in @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids.Contains([int]$_.OwningProcess) -and $_.State -ne 'Listen' })) {
                '{0},{1},{2},{3}:{4},{5}' -f $now, $c.OwningProcess, $names[[int]$c.OwningProcess], $c.RemoteAddress, $c.RemotePort, $c.State |
                    Add-Content -Encoding UTF8 -LiteralPath $Csv
            }
            Start-Sleep -Milliseconds 1000
        }
    }
    $deadline = (Get-Date).AddSeconds(60)
    $page = $null
    while (-not $page -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try { $page = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list") | Where-Object { $_.type -eq 'page' -and $_.url -eq 'http://tauri.localhost/' } } catch { $page = $null }
    }
    if (-not $page) { throw "The app did not open its window with CDP on port $Port." }
    $tree = Get-Tree $process.Id $since
    $owner = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)[0].OwningProcess
    $browser = @($tree | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -notmatch '--type=' })[0]
    # Only booleans are kept: command lines contain local paths.
    $flags = [ordered]@{
        cdpPortOwnedByAppTree = [bool](@($tree | Where-Object { $_.ProcessId -eq $owner }).Count)
        freshProfile          = [bool]($browser -and $browser.CommandLine.Contains($ProfileDir))
        netLog                = [bool]($browser -and $browser.CommandLine.Contains('--log-net-log'))
        quicDisabled          = [bool]($browser -and $browser.CommandLine.Contains('--disable-quic'))
        appDisablesSmartScreen = [bool]($browser -and $browser.CommandLine.Contains('msSmartScreenProtection'))
    }
    if (-not $flags.cdpPortOwnedByAppTree) { throw "Port $Port does not belong to the launched app." }
    return [pscustomobject]@{ Run = $Run; Process = $process; Since = $since; NetLog = $netlog; StopFile = $stopFile; Sampler = $sampler; Sockets = $socketsCsv; Flags = $flags }
}

function Stop-App($App) {
    [void]$App.Process.CloseMainWindow()
    $deadline = (Get-Date).AddSeconds(60)
    $forced = $false
    while ((Get-Tree $App.Process.Id $App.Since | Measure-Object).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    $left = @(Get-Tree $App.Process.Id $App.Since)
    if ($left.Count) { $forced = $true; $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
    New-Item -ItemType File -Path $App.StopFile | Out-Null
    Wait-Job $App.Sampler -Timeout 30 | Out-Null
    Remove-Job $App.Sampler -Force
    return $forced
}

function Invoke-Node([string[]]$Arguments) {
    & node --experimental-websocket @Arguments
    if ($LASTEXITCODE -ne 0) { throw "node $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Get-Summary($App, [bool]$Forced) {
    $summaryPath = Join-Path $work "summary-$($App.Run).json"
    & node scripts/netlog-summary.mjs $App.NetLog --markers $allMarkers --out $summaryPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "netlog-summary failed for $($App.Run)" }
    $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $sockets = @(Import-Csv -LiteralPath $App.Sockets -Encoding UTF8)
    $external = @($sockets | Where-Object { $_.remote -notmatch '^(127\.|::1|0\.0\.0\.0|::)' })
    # Sockets NetLog never saw were opened outside Chromium's network service (for example by
    # the WebView2 browser process itself): their content cannot be inspected by this method.
    $netlogEndpoints = @($summary.endpoints | ForEach-Object { $_.endpoint -replace '^\[|\](?=:\d+$)', '' })
    $outsideNetLog = @($external | Where-Object { $netlogEndpoints -notcontains $_.remote } |
        Group-Object process, pid | ForEach-Object { '{0}: {1}' -f $_.Name, ((@($_.Group | ForEach-Object { $_.remote }) | Sort-Object -Unique) -join ', ') })
    return [pscustomobject]@{
        run                 = $App.Run
        flags               = $App.Flags
        forcedExit          = $Forced
        netlogTruncated     = $summary.truncated
        captureModeHasBytes = $summary.captureModeHasBytes
        externalHosts       = @($summary.hosts | Where-Object { $_.class -eq 'external' } | ForEach-Object { $_.host })
        externalUrls        = @($summary.urls | Where-Object { $_.class -eq 'external' } | ForEach-Object { $_.url })
        markerHits          = @($summary.markerHits | ForEach-Object { '{0} | {1} | {2} | {3} | {4}' -f $_.class, $_.remote, $_.marker, $_.variant, $_.place })
        socketsByProcess    = @($external | Group-Object process | ForEach-Object { '{0}: {1}' -f $_.Name, ((@($_.Group | ForEach-Object { $_.remote }) | Sort-Object -Unique) -join ', ') })
        socketsOutsideNetLog = $outsideNetLog
    }
}

$results = @()
Remove-Item Env:CAPACITY_SMOKE_OFFLINE -ErrorAction SilentlyContinue

# --- control -------------------------------------------------------------------------------
$app = Start-App 'control' (Join-Path $work 'profile-control')
Invoke-Node @('scripts/network-check-control.mjs', "$Port", $controlMarker)
Start-Sleep -Seconds 3
$forced = Stop-App $app
$results += Get-Summary $app $forced

# --- fresh: new profile, full scenario with marker data ----------------------------------------
$profileDir = Join-Path $work 'profile'
$env:CAPACITY_SMOKE_MARKER = "$asciiMarker $cyrillicMarker"
$app = Start-App 'fresh' $profileDir
Invoke-Node @('scripts/webview-smoke.mjs', "$Port")
$exportFrom = Get-Date
Invoke-Node @('scripts/report-export-smoke.mjs', "$Port")
$exportTo = Get-Date
$forced = Stop-App $app
$fresh = Get-Summary $app $forced
$fresh | Add-Member -NotePropertyName saveDialogWindow -NotePropertyValue ('{0:HH:mm:ss}-{1:HH:mm:ss}' -f $exportFrom, $exportTo)
$results += $fresh

# --- warm: the same profile again ---------------------------------------------------------------
$app = Start-App 'warm' $profileDir
Invoke-Node @('scripts/webview-smoke.mjs', "$Port")
$forced = Stop-App $app
$results += Get-Summary $app $forced
Remove-Item Env:CAPACITY_SMOKE_MARKER -ErrorAction SilentlyContinue
# report-export-smoke writes its test project and reports to %TEMP%; remove this run's folders.
Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'capacity report smoke *' |
    Where-Object { $_.CreationTime -ge $startedAt } | Remove-Item -Recurse -Force

# --- verdict -----------------------------------------------------------------------------------
$control = $results | Where-Object { $_.run -eq 'control' }
$controlFound = [bool](@($control.markerHits | Where-Object { $_ -match "^external \| .* \| $controlMarker \|" }).Count)
$leaks = @($results | Where-Object { $_.run -ne 'control' } | ForEach-Object { $_.markerHits } | Where-Object { $_ -match '^(external|unknown) ' })
$verdict = [ordered]@{
    tag               = $Tag
    zipSha256         = $actualHash
    controlMarkerFound = $controlFound
    markerLeaks       = $leaks
    passed            = $controlFound -and -not $leaks.Count
    runs              = $results
}
$verdictJson = $verdict | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $work 'verdict.json'), $verdictJson, (New-Object Text.UTF8Encoding $false))
$verdictJson
if (-not $verdict.passed) { exit 1 }
