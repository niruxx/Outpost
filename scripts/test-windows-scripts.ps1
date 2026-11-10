$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$files = @((Get-ChildItem -LiteralPath (Join-Path $root 'dist/windows') -Filter '*.ps1')) + @((Get-ChildItem -LiteralPath $root -Filter '*.ps1'))
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors) { throw ($parseErrors | Out-String) }
}
foreach ($action in @('install','update','uninstall')) {
    foreach ($relative in @("$action.ps1", "dist/windows/$action.ps1")) {
        $helpOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root $relative) -y --help
        if ($LASTEXITCODE -ne 0 -or "$helpOutput" -notmatch 'Usage:') { throw "Help failed: $relative" }
    }
}
. (Join-Path $root 'dist/windows/common.ps1')
$caught = $false
try { Invoke-Checked 'powershell.exe' @('-NoProfile', '-Command', 'exit 7') } catch { $caught = $_.Exception.Message -match 'exit code 7' }
if (!$caught) { throw 'External-command failures are not propagated.' }
$caught = $false
try { Assert-CheckoutPath (Split-Path $ProjectRoot -Parent) | Out-Null } catch { $caught = $true }
if (!$caught) { throw 'Deletion outside the checkout was accepted.' }
Assert-CheckoutPath (Join-Path $ProjectRoot 'server/dist') | Out-Null
Write-Output 'PowerShell syntax, root/platform help and failure propagation checks passed.'
