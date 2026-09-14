$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$record = Join-Path $repoPath 'verification/admin-preview/host.json'
if (Test-Path -LiteralPath $record) {
  $hostInfo = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
  $target = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$hostInfo.processId)"
  $expectedScript = Join-Path $repoPath 'tests/admin-preview.ts'
  if ($target -and $target.Name -eq 'node.exe' -and $target.CommandLine.Contains($expectedScript)) {
    Stop-Process -Id $target.ProcessId
    Write-Output '本地管理后台已停止，测试数据保留。'
  }
}
