param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Options)
. "$PSScriptRoot/common.ps1"
$yes = $false
$purge = $false
foreach ($option in $Options) {
    switch ($option) {
        '-y' { $yes = $true }
        '--yes' { $yes = $true }
        '--purge' { $purge = $true }
        { $_ -in '-h','--help' } { Write-Host 'Usage: .\uninstall.ps1 [-y|--yes] [--purge] (purge requires typing delete)'; exit 0 }
        default { throw "Unknown option: $option" }
    }
}
if (!(Confirm-Action 'Remove the Outpost login task and build output?' $yes)) { exit 0 }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Start-Sleep -Seconds 3
}
Write-Host 'Stop any separately started Outpost process before deleting its files.'
foreach ($folder in @('node_modules','server/node_modules','web/node_modules','server/dist','web/dist')) { Remove-CheckoutFolder $folder }
if ($purge) {
    $dataPath = Get-OutpostData
    # Restrict automated deletion to the checkout; external data is retained for manual cleanup.
    if (!$dataPath.StartsWith($ProjectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "External data retained: $dataPath" }
    if ((Read-Host "Permanently delete $dataPath (worlds and database)? Type delete") -eq 'delete') {
        if (Test-Path -LiteralPath $dataPath) {
            $resolvedData = Assert-CheckoutPath $dataPath
            Remove-Item -LiteralPath $resolvedData -Recurse -Force
        }
    }
}
Write-Host 'Uninstalled. Checkout, Java, Node.js and update backups retained.'
exit 0
