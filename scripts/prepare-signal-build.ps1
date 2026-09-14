$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $root 'integrations/tools'
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$nodeVersion = '24.17.0'
$nodeName = "node-v$nodeVersion-win-x64"
$nodeDir = Join-Path $toolRoot $nodeName
if (!(Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
  Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile (Join-Path $toolRoot 'node-SHASUMS256.txt')
  $archive = Join-Path $toolRoot "$nodeName.zip"
  Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$nodeName.zip" -OutFile $archive
  $expected = ((Get-Content (Join-Path $toolRoot 'node-SHASUMS256.txt') | Where-Object { $_.EndsWith("  $nodeName.zip") }) -split '\s+')[0]
  if (!$expected -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Node checksum mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot
}
& (Join-Path $nodeDir 'node.exe') --version
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = if (Test-Path -LiteralPath $vswhere) { & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if (!$vs) {
  $bootstrap = Join-Path $toolRoot 'vs_buildtools.exe'
  if (!(Test-Path -LiteralPath $bootstrap)) { Invoke-WebRequest 'https://aka.ms/vs/17/release/vs_buildtools.exe' -OutFile $bootstrap }
  $signature = Get-AuthenticodeSignature -LiteralPath $bootstrap
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Build Tools signature verification failed' }
  $installer = Start-Process -FilePath $bootstrap -ArgumentList '--quiet','--wait','--norestart','--add','Microsoft.VisualStudio.Workload.VCTools','--includeRecommended' -WindowStyle Hidden -PassThru -Wait
  "Build Tools exit: $($installer.ExitCode)"
  if ($installer.ExitCode -notin @(0,3010)) { throw 'Build Tools installation failed; inspect installer logs' }
  $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
@{ node = $nodeDir; visualStudio = $vs; preparedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content (Join-Path $toolRoot 'build-tools.json')
