param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Options)
$ErrorActionPreference = 'Stop'
if ($Options -contains '--guide') {
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'docs/server-management.md') -Raw
    exit 0
}
if (($Options -contains '--help') -or ($Options -contains '-h')) {
    Write-Host 'Root option: --guide prints the file structure and per-OS server management guide.'
}
if ($env:OS -eq 'Windows_NT') {
    & (Join-Path $PSScriptRoot 'dist/windows/uninstall.ps1') @Options
} else {
    & bash (Join-Path $PSScriptRoot 'uninstall.sh') @Options
    exit $LASTEXITCODE
}
