param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$adminUrl = 'http://127.0.0.1:5174'
$nodePath = Join-Path $repoPath 'integrations/tools/node-v24.17.0-win-x64/node.exe'
$scriptPath = Join-Path $repoPath 'scripts/admin-live-server.mjs'
$recordDirectory = Join-Path $repoPath 'verification/admin-live'
$ready = $false
try { $health = Invoke-RestMethod -Uri "$adminUrl/__local/health" -TimeoutSec 2; $ready = $health.service -eq 'hellodog-admin-live' } catch {}
if (-not $ready) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'website/dist-admin-live/index.html'))) {
    Push-Location (Join-Path $repoPath 'website')
    try {
      & $nodePath 'node_modules/vue-tsc/bin/vue-tsc.js' --noEmit
      if ($LASTEXITCODE -ne 0) { throw '管理页面检查失败。' }
      & $nodePath 'node_modules/vite/bin/vite.js' build --mode admin-live --outDir dist-admin-live
      if ($LASTEXITCODE -ne 0) { throw '管理页面构建失败。' }
    } finally { Pop-Location }
  }
  New-Item -ItemType Directory -Path $recordDirectory -Force | Out-Null
  $adminProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $scriptPath + '"') -WorkingDirectory $repoPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $recordDirectory 'host.log') -RedirectStandardError (Join-Path $recordDirectory 'host-error.log')
  @{ processId = $adminProcess.Id; script = $scriptPath; url = $adminUrl } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $recordDirectory 'host.json') -Encoding utf8
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { $health = Invoke-RestMethod -Uri "$adminUrl/__local/health" -TimeoutSec 1; if ($health.service -eq 'hellodog-admin-live') { $ready = $true; break } } catch {}
    $adminProcess.Refresh(); if ($adminProcess.HasExited) { break }
  }
  if (-not $ready) { throw '管理后台未启动成功，请查看 verification/admin-live/host-error.log。' }
}
if (-not $NoOpen) { Start-Process -FilePath "$adminUrl/admin" -WindowStyle Hidden }
Write-Output "HelloDog 管理后台：$adminUrl/admin"
