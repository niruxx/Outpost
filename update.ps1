param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Options)
$ErrorActionPreference = 'Stop'
if ($env:OS -eq 'Windows_NT') {
    & (Join-Path $PSScriptRoot 'dist/windows/update.ps1') @Options
} else {
    & bash (Join-Path $PSScriptRoot 'update.sh') @Options
    exit $LASTEXITCODE
}
