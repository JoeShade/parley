# Register the Explorer helper for the current user. No administrator required.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Classes\parley-files'
$helperDir = Join-Path $env:LOCALAPPDATA 'Parley\FileExplorer'
if ($Uninstall) {
    if (Test-Path $key) { Remove-Item -LiteralPath $key -Recurse }
    Write-Host 'Parley Explorer link removed. Saved file copies are unchanged.'
    exit
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $projectRoot 'docker-compose.yml'))) { throw 'Run the installer from your Parley checkout.' }
New-Item -ItemType Directory -Force -Path $helperDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'open-windows-files.ps1') -Destination $helperDir -Force
@{ projectRoot = $projectRoot } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $helperDir 'config.json')
$handler = Join-Path $helperDir 'open-windows-files.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value 'URL:Parley meeting files'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$commandKey = Join-Path $key 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
# The URI is an argument to a fixed script, never interpolated into PowerShell code.
Set-Item -LiteralPath $commandKey -Value ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -Uri "%1"' -f $powershell, $handler)
Write-Host 'Installed. Open files in Parley can now launch File Explorer.'
Write-Host ('Meeting file copies will be in: ' + (Join-Path $projectRoot 'saved-files'))
