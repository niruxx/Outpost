$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$TaskName = 'Outpost Panel'
function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}
function Confirm-Action {
    param([string]$Message, [bool]$Yes)
    if ($Yes) { return $true }
    return (Read-Host "$Message [y/N]") -match '^[Yy]'
}
function Get-OutpostData {
    $dataPath = $env:DATA_DIR
    if (!$dataPath) { $dataPath = $env:OUTPOST_DATA_DIR }
    if (!$dataPath) { $dataPath = $env:MULTICRAFT_DATA_DIR }
    if (!$dataPath) { $dataPath = Join-Path $ProjectRoot 'server/data' }
    if (![IO.Path]::IsPathRooted($dataPath)) { $dataPath = Join-Path $ProjectRoot "server/$dataPath" }
    return [IO.Path]::GetFullPath($dataPath)
}
function Backup-OutpostData {
    $backupRoot = Join-Path (Split-Path $ProjectRoot -Parent) 'outpost-update-backups'
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $commit = & git -C $ProjectRoot rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not record rollback commit.' }
    Set-Content -LiteralPath (Join-Path $backupRoot "previous-commit-$stamp.txt") -Value $commit
    $dataPath = Get-OutpostData
    if (Test-Path -LiteralPath $dataPath) {
        # Windows tar supports large worlds and includes dotfiles.
        Invoke-Checked 'tar.exe' @('-czf', (Join-Path $backupRoot "data-$stamp.tar.gz"), '-C', (Split-Path $dataPath -Parent), (Split-Path $dataPath -Leaf))
    }
    Write-Host "Backup and rollback commit saved in $backupRoot"
}
function Assert-CheckoutPath {
    param([string]$Path)
    $targetPath = [IO.Path]::GetFullPath($Path)
    if (!$targetPath.StartsWith($ProjectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing path outside checkout.' }
    $current = $targetPath
    while ($current -ne $ProjectRoot) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing deletion through a link or junction: $current" }
        }
        $current = Split-Path $current -Parent
    }
    return $targetPath
}
function Remove-CheckoutFolder {
    param([string]$RelativePath)
    $targetPath = Assert-CheckoutPath (Join-Path $ProjectRoot $RelativePath)
    if (Test-Path -LiteralPath $targetPath) { Remove-Item -LiteralPath $targetPath -Recurse -Force }
}
