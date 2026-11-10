param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Options)
. "$PSScriptRoot/common.ps1"
$yes = $false
$java = $true
$port = 8642
foreach ($option in $Options) {
    switch -Regex ($option) {
        '^(-y|--yes)$' { $yes = $true; break }
        '^--no-java$' { $java = $false; break }
        '^--no-containers$' { break }
        '^--port=(\d+)$' { $port = [int]$Matches[1]; break }
        '^(-h|--help)$' { Write-Host 'Usage: .\install.ps1 [-y|--yes] [--no-java] [--port=N]'; exit 0 }
        default { throw "Unknown option: $option" }
    }
}
if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid port.' }
Set-Location -LiteralPath $ProjectRoot
Refresh-Path
$nodeOk = $false
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
    & node.exe -e 'const [a,b]=process.versions.node.split(/\x2e/).map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'
    $nodeOk = $LASTEXITCODE -eq 0
}
if (!$nodeOk) {
    Invoke-Checked 'winget.exe' @('install', '--exact', '--id', 'OpenJS.NodeJS.LTS', '--accept-package-agreements', '--accept-source-agreements')
    Refresh-Path
    Invoke-Checked 'node.exe' @('-e', 'const [a,b]=process.versions.node.split(/\x2e/).map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)')
}
if ($java) {
    foreach ($major in @(21, 25)) {
        & winget.exe list --exact --id "EclipseAdoptium.Temurin.$major.JDK" --accept-source-agreements | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Invoke-Checked 'winget.exe' @('install', '--exact', '--id', "EclipseAdoptium.Temurin.$major.JDK", '--accept-package-agreements', '--accept-source-agreements')
        }
    }
    Refresh-Path
}
$oldTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($oldTask) { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 3 }
Invoke-Checked 'npm.cmd' @('run', 'setup')
Invoke-Checked 'npm.cmd' @('run', 'build')
if (Confirm-Action 'Run Outpost now and automatically at login?' $yes) {
    $nodePath = (Get-Command node.exe).Source
    # A dedicated launcher preserves PORT and the dependency PATH for login sessions.
    $launcher = Join-Path $ProjectRoot 'state/windows-launch.ps1'
    New-Item -ItemType Directory -Force -Path (Split-Path $launcher -Parent) | Out-Null
    $quotedNode = $nodePath.Replace("'", "''")
    $quotedServer = (Join-Path $ProjectRoot 'server').Replace("'", "''")
    $quotedPath = $env:Path.Replace("'", "''")
    $quotedData = (Get-OutpostData).Replace("'", "''")
    Set-Content -LiteralPath $launcher -Value "`$env:PORT='$port'`n`$env:Path='$quotedPath'`n`$env:DATA_DIR='$quotedData'`nSet-Location -LiteralPath '$quotedServer'`n& '$quotedNode' dist/index.js"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $healthy = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 2
        try { Invoke-WebRequest "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; $healthy = $true; break } catch { }
    }
    if (!$healthy) { throw "Outpost did not answer on port $port. Check the '$TaskName' scheduled task." }
} else {
    Write-Host 'Start Outpost from this checkout with npm start.'
}
Write-Host "Outpost ready: http://localhost:$port"
exit 0
