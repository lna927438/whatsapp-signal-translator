$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path (Join-Path $prototypeRoot '../..')).Path
$electronBinary = Join-Path $repositoryRoot 'node_modules/electron/dist/electron.exe'
$prototypeEntry = Join-Path $prototypeRoot 'main.cjs'
$env:TEMP = 'D:/UserAppData/Temp'
$env:TMP = 'D:/UserAppData/Temp'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$prototypeProcess = Start-Process -FilePath $electronBinary -ArgumentList @(('"' + $prototypeEntry + '"')) -WorkingDirectory $repositoryRoot -WindowStyle Normal -PassThru
[pscustomobject]@{ ProcessId = $prototypeProcess.Id; Mode = 'Isolated interactive embedded validation'; DataDrive = 'D' }
