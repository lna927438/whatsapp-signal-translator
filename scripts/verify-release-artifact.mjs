import {readFile} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {verifyUpdateSignature} from '../src/shared/updateSignature.ts'
const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined
const manifest=option('--manifest'),installer=option('--installer')
if(!manifest||!installer)throw new Error('Required: --manifest PATH --installer PATH; optional --source-commit SHA.')
const trust=JSON.parse(await readFile(option('--trust')||new URL('../resources/security/update-trust.json',import.meta.url),'utf8'))
const value=verifyUpdateSignature(JSON.parse(await readFile(manifest,'utf8')),trust)
if(option('--source-commit')&&value.sourceCommit!==option('--source-commit'))throw new Error('Artifact source commit does not match the reviewed release.')
const hash=createHash('sha256');let size=0
for await(const chunk of createReadStream(installer)){hash.update(chunk);size+=chunk.length}
if(hash.digest('hex')!==value.sha256||size!==value.size)throw new Error('Installer checksum or size does not match signed metadata.')
if(trust.windowsInstallerPolicy!==undefined&&!['authenticode','signed-manifest'].includes(trust.windowsInstallerPolicy))throw new Error('Unknown embedded installer verification policy.')
const requireWindowsPublisher=!args.includes('--local-signature-only')&&trust.windowsInstallerPolicy!=='signed-manifest'
if(requireWindowsPublisher){
 if(process.platform!=='win32')throw new Error('Windows publisher verification requires Windows.')
 const script="$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:HELLODOG_VERIFY_INSTALLER; [pscustomobject]@{status=[string]$s.Status;subject=$s.SignerCertificate.Subject;timestamped=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress"
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,env:{...process.env,HELLODOG_VERIFY_INSTALLER:installer}})
 const result=JSON.parse(stdout.trim())
 if(result.status!=='Valid'||result.timestamped!==true||!trust.windowsPublisherSubjects.includes(result.subject))throw new Error('Installer publisher or timestamp is not trusted.')
}
console.log(JSON.stringify({verified:true,version:value.version,sourceCommit:value.sourceCommit,updateSignatureVerified:true,windowsPublisherVerified:requireWindowsPublisher,installerPolicy:trust.windowsInstallerPolicy||'authenticode',localOnly:args.includes('--local-signature-only')}))
