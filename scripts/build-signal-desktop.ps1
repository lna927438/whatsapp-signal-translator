param([switch]$InstallOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeRoot = Join-Path $root 'integrations/tools/node-v24.17.0-win-x64'
$pnpmRoot = Join-Path $root 'integrations/tools/pnpm'
$node = Join-Path $nodeRoot 'node.exe'
$env:PATH = "$nodeRoot;$pnpmRoot/node_modules/.bin;$env:PATH"
$env:PYTHON = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path -LiteralPath $env:PYTHON)) { $env:PYTHON = (Get-Command python -ErrorAction Stop).Source }
$env:npm_config_msvs_version = '2022'
$env:CI = '1'
$pnpm = Join-Path $pnpmRoot 'node_modules/pnpm/bin/pnpm.cjs'
if (!(Test-Path -LiteralPath $pnpm)) {
  & $node (Join-Path $nodeRoot 'node_modules/npm/bin/npm-cli.js') install --prefix $pnpmRoot pnpm@11.5.2 --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'pnpm setup failed' }
}
$signalCheckout = & $node -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" (Join-Path $root 'integrations/signal-desktop')
Set-Location $signalCheckout
& $node (Join-Path $root 'scripts/apply-signal-security.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Signal security dependency preparation failed' }
& $node $pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Signal dependency installation failed' }
$electronPackage = & $node -e "process.stdout.write(require('path').dirname(require('fs').realpathSync('node_modules/electron/index.js')))"
if (!(Test-Path -LiteralPath (Join-Path $electronPackage 'dist/electron.exe'))) {
  $electronArchive = Join-Path $root 'integrations/tools/electron-v43.5.0-win32-x64.zip'
  if (!(Test-Path -LiteralPath $electronArchive)) { Invoke-WebRequest 'https://github.com/electron/electron/releases/download/v43.5.0/electron-v43.5.0-win32-x64.zip' -OutFile $electronArchive }
  $checksum = (Get-Content (Join-Path $electronPackage 'checksums.json') -Raw | ConvertFrom-Json).'electron-v43.5.0-win32-x64.zip'
  if (!$checksum -or (Get-FileHash -LiteralPath $electronArchive -Algorithm SHA256).Hash -ne $checksum) { throw 'Electron checksum mismatch' }
  Expand-Archive -LiteralPath $electronArchive -DestinationPath (Join-Path $electronPackage 'dist') -Force
  [IO.File]::WriteAllText((Join-Path $electronPackage 'path.txt'),'electron.exe')
}
if (!$InstallOnly) {
  & $node (Join-Path $root 'scripts/verify-signal-security.mjs') --source-only
  if ($LASTEXITCODE -ne 0) { throw 'Signal security dependency verification failed' }
  & $node (Join-Path $root 'scripts/patch-signal-desktop.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Signal integration patch failed' }
  & $node $pnpm generate
  if ($LASTEXITCODE -ne 0) { throw 'Signal build failed' }
}
