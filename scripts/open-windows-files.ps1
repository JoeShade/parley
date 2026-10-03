param([Parameter(Mandatory = $true)][string]$Uri)
$ErrorActionPreference = 'Stop'
$mutex = $null
$locked = $false
try {
    # Reject everything except one positive decimal meeting ID. No paths,
    # queries, extra arguments, or commands can arrive through the protocol.
    if ($Uri -cnotmatch '^parley-files://meeting/([1-9][0-9]{0,14})/?$') { throw 'Invalid Parley meeting link.' }
    $meetingId = $Matches[1]
    $configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    $projectRoot = (Resolve-Path -LiteralPath $configuration.projectRoot).Path
    Set-Location -LiteralPath $projectRoot
    $mutex = [System.Threading.Mutex]::new($false, ('Local\ParleyFiles-' + $meetingId))
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw 'This meeting folder is already being prepared.' }
    Write-Host 'Preparing meeting exports and copying retained audio...'
    $output = & docker compose exec -T bot node scripts/meeting-files.mjs $meetingId
    if ($LASTEXITCODE -ne 0) { throw 'Could not read meeting files. Check Docker Desktop and the bot container.' }
    $line = @($output | Where-Object { $_.StartsWith('PARLEY_FILES=') }) | Select-Object -Last 1
    if (-not $line) { throw 'Update the Parley bot container before using Open files.' }
    $files = $line.Substring('PARLEY_FILES='.Length) | ConvertFrom-Json
    if ([string]$files.meetingId -ne $meetingId) { throw 'Meeting file manifest did not match the requested ID.' }
    $destination = Join-Path (Join-Path $projectRoot 'saved-files') ('meeting-' + $meetingId)
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $exportPaths = @($files.exports.markdown, $files.exports.json)
    if ($files.exports.wav) { $exportPaths += $files.exports.wav }
    foreach ($source in $exportPaths) {
        if (-not $source -or -not $source.StartsWith('/')) { throw 'Invalid export path.' }
        & docker compose cp ('bot:' + $source) $destination
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the exported transcript.' }
    }
    if ($files.audio) {
        if (-not $files.audio.StartsWith('/')) { throw 'Invalid audio path.' }
        $audioDestination = Join-Path $destination 'audio'
        New-Item -ItemType Directory -Force -Path $audioDestination | Out-Null
        & docker compose cp ('bot:' + $files.audio + '/.') $audioDestination
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the retained audio.' }
    } else { Write-Host 'No retained audio is available; opening the transcript exports.' }
    # Copies are for browsing: canonical recordings remain in Docker's volume.
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $destination + '"')
} catch {
    Write-Host ('Parley: ' + $_.Exception.Message) -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
