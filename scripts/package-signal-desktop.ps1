param([string]$OutputDirectory = 'release/hellodog-security-core')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeRoot = Join-Path $root 'integrations/tools/node-v24.17.0-win-x64'
$pnpmRoot = Join-Path $root 'integrations/tools/pnpm'
$node = Join-Path $nodeRoot 'node.exe'
$env:PATH = "$nodeRoot;$pnpmRoot/node_modules/.bin;$env:PATH"
$env:PYTHON = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path -LiteralPath $env:PYTHON)) { $env:PYTHON = (Get-Command python -ErrorAction Stop).Source }
$env:CI = '1'
$env:SIGNAL_ENV = 'production'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$checkout = & $node -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" (Join-Path $root 'integrations/signal-desktop')
Set-Location $checkout
$target = [IO.Path]::GetFullPath((Join-Path $checkout $OutputDirectory))
$allowed = [IO.Path]::GetFullPath((Join-Path $checkout 'release')) + [IO.Path]::DirectorySeparatorChar
if (-not $target.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Signal package output must remain inside its release directory.' }
$electronDist = & $node -e "process.stdout.write(require('path').join(require('path').dirname(require('fs').realpathSync('node_modules/electron/index.js')),'dist'))"
& $node (Join-Path $pnpmRoot 'node_modules/pnpm/bin/pnpm.cjs') exec electron-builder --dir --win --x64 --publish never --config.npmRebuild=false --config.win.signAndEditExecutable=false "--config.electronDist=$electronDist" "--config.directories.output=$OutputDirectory"
if ($LASTEXITCODE -ne 0) { throw 'Signal core packaging failed' }
