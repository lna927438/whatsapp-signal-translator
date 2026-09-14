$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -LiteralPath (Join-Path $root 'integrations/signal-desktop.lock.json') -Raw | ConvertFrom-Json
$checkout = Join-Path $root 'integrations/signal-desktop'
if (-not (Test-Path -LiteralPath $checkout)) {
  & git -c core.longpaths=true clone --depth 1 --branch $lock.tag $lock.repository $checkout
  if ($LASTEXITCODE -ne 0) { throw 'Pinned Signal checkout failed' }
}
$revision = & git -C $checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision.Trim() -ne $lock.commit) { throw 'Signal revision does not match the reviewed source lock' }
& (Join-Path $root 'scripts/prepare-signal-build.ps1')
& (Join-Path $root 'scripts/build-signal-desktop.ps1')
& (Join-Path $root 'scripts/build-native-host.ps1')
& (Join-Path $root 'scripts/package-signal-desktop.ps1')
$node = Join-Path $root 'integrations/tools/node-v24.17.0-win-x64/node.exe'
& $node (Join-Path $root 'scripts/prepare-signal-bundle.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Pinned Signal compatibility resources failed' }
& $node (Join-Path $root 'scripts/verify-signal-security.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Packaged Signal security check failed' }
