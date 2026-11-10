param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Options)
$ErrorActionPreference = 'Stop'
if ($env:OS -eq 'Windows_NT') {
    & (Join-Path $PSScriptRoot 'dist/windows/install.ps1') @Options
} else {
    & bash (Join-Path $PSScriptRoot 'install.sh') @Options
    exit $LASTEXITCODE
}
