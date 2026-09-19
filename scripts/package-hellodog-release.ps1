param([switch]$Prerelease, [switch]$LocalUnsigned, [switch]$Unsigned, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'integrations/tools/node-v24.17.0-win-x64/node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
Set-Location $root
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($Prerelease) {
  if ($version -notmatch '^\d+\.\d+\.\d+-(beta|rc)\.\d+$') { throw 'A beta or RC version is required for prerelease packaging.' }
} elseif ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'A stable release version is required.' }
$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $root ('release/v' + $version) }
if ((Test-Path -LiteralPath $output) -and (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1)) { throw 'Build output must be a new or empty directory; existing artifacts are preserved.' }
& (Join-Path $PSScriptRoot 'build-google-voice-host.ps1')
& (Join-Path $PSScriptRoot 'build-google-voice-messaging.ps1')
& $node integrations/google-voice-extension/build-content.mjs
if ($LASTEXITCODE -ne 0) { throw 'Google Voice extension build failed.' }
& $node scripts/verify-signal-security.mjs
if ($LASTEXITCODE -ne 0) { throw 'Signal security core verification failed.' }
& $node scripts/verify-voice-resources.mjs
if ($LASTEXITCODE -ne 0) { throw 'Voice resources verification failed.' }
$sourceNotice = [IO.File]::ReadAllText((Join-Path $root 'integrations/notices/SOURCE.template.txt')).Replace('{version}', $version)
[IO.File]::WriteAllText((Join-Path $root 'integrations/notices/SOURCE.txt'), $sourceNotice)
if ($LocalUnsigned -and -not $Prerelease) { throw 'Unsigned packaging is permitted only for local prerelease acceptance.' }
if ($Unsigned) {
  $policy = Get-Content -LiteralPath (Join-Path $root 'security/release-policy.json') -Raw | ConvertFrom-Json
  $trust = Get-Content -LiteralPath (Join-Path $root 'resources/security/update-trust.json') -Raw | ConvertFrom-Json
  if ($policy.ownerAuthorizedProduction -ne $true -or $policy.requireSignedInstaller -ne $false -or $policy.requireSignedManifest -ne $true -or $trust.windowsInstallerPolicy -ne 'signed-manifest' -or @($trust.keys.PSObject.Properties).Count -eq 0) { throw 'Explicit unsigned-release authorization and trusted update keys are required.' }
}
if ($LocalUnsigned -or $Unsigned) { $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false' }
& $node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Renderer typecheck failed.' }
& $node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
if ($LASTEXITCODE -ne 0) { throw 'Main typecheck failed.' }
& $node node_modules/electron-vite/bin/electron-vite.js build
if ($LASTEXITCODE -ne 0) { throw 'HelloDog build failed.' }
# Unsigned distribution is an explicit owner-approved mode; update signing remains mandatory.
$securityBuildArgs = @('--require','./scripts/windows-build-paths.cjs','node_modules/electron-builder/cli.js','--win','nsis','--publish','never',"--config.directories.output=$output")
if ($LocalUnsigned -or $Unsigned) { $securityBuildArgs += @('--config.forceCodeSigning=false','--config.win.signExecutable=false') } else { $securityBuildArgs += '--config.forceCodeSigning=true' }
& $node @securityBuildArgs
if ($LASTEXITCODE -ne 0) { throw 'HelloDog packaging failed.' }
