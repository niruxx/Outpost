param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Options)
. "$PSScriptRoot/common.ps1"
$yes = $false
$backup = $true
foreach ($option in $Options) {
    switch ($option) {
        '-y' { $yes = $true }
        '--yes' { $yes = $true }
        '--no-backup' { $backup = $false }
        { $_ -in '-h','--help' } { Write-Host 'Usage: .\update.ps1 [-y|--yes] [--no-backup]'; exit 0 }
        default { throw "Unknown option: $option" }
    }
}
Set-Location -LiteralPath $ProjectRoot
Refresh-Path
$changes = & git status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect git checkout.' }
if ($changes) { throw 'Commit or stash local changes before updating.' }
if (!(Confirm-Action 'Back up data and update Outpost?' $yes)) { exit 0 }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$wasRunning = $task -and $task.State -eq 'Running'
if ($task) { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 3 }
try {
    Write-Host 'Stop any separately started Outpost process before continuing.'
    if ($backup) { Backup-OutpostData }
    Invoke-Checked 'git.exe' @('pull', '--ff-only')
    Invoke-Checked 'npm.cmd' @('run', 'setup')
    Invoke-Checked 'npm.cmd' @('run', 'build')
} finally {
    if ($wasRunning) { Start-ScheduledTask -TaskName $TaskName }
}
Write-Host 'Update complete. Data retained.'
exit 0
