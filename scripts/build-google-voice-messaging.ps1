$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is missing.' }
& $compiler /nologo /target:exe ('/out:' + (Join-Path $root 'resources/native/GoogleVoiceMessagingHost.exe')) (Join-Path $root 'resources/native/GoogleVoiceMessagingHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Google Voice messaging host build failed.' }
