$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'integrations/tools/node-v24.17.0-win-x64/node.exe'
Set-Location $root
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch 'beta\.(\d+)$') { throw 'A local beta version is required.' }
$output = 'release/v' + $version
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
& $node node_modules/electron-vite/bin/electron-vite.js build
if ($LASTEXITCODE -ne 0) { throw 'HelloDog build failed.' }
# Keep the HelloDog icon/version resources; this local beta is not code-signed.
& $node node_modules/electron-builder/cli.js --win nsis --publish never "--config.directories.output=$output" --config.win.signExecutable=false
if ($LASTEXITCODE -ne 0) { throw 'HelloDog beta packaging failed.' }
