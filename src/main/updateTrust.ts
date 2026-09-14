import { readFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { verifyUpdateSignature, type UpdateTrust } from '../shared/updateSignature'

export async function loadUpdateTrust():Promise<UpdateTrust>{
  // Production trust belongs to the integrity-protected app archive.
  const root=app.isPackaged?app.getAppPath():join(__dirname,'../..')
  const path=join(root,'resources/security/update-trust.json')
  const trust=JSON.parse(await readFile(path,'utf8')) as UpdateTrust
  if(!trust.keys||typeof trust.keys!=='object'||!Array.isArray(trust.windowsPublisherSubjects)||!Object.keys(trust.keys).length)throw new Error('正式更新签名尚未配置。请使用官网入口，当前版本会继续保留。')
  if(trust.windowsInstallerPolicy!==undefined&&!['authenticode','signed-manifest'].includes(trust.windowsInstallerPolicy))throw new Error('更新验证策略无效。')
  return trust
}
export async function trustedUpdate(raw:unknown){return verifyUpdateSignature(raw,await loadUpdateTrust())}
export function validWindowsSignature(result:unknown,trust:UpdateTrust):boolean{
  const value=result as {status?:string;subject?:string;timestamped?:boolean}|null
  return Boolean(value?.status==='Valid'&&value.timestamped===true&&value.subject&&trust.windowsPublisherSubjects.includes(value.subject))
}
export async function verifyWindowsInstaller(path:string,manifest?:unknown):Promise<void>{
  if(process.platform!=='win32')throw new Error('此安装包只能在 Windows 上验证。')
  const trust=await loadUpdateTrust()
  if(trust.windowsInstallerPolicy==='signed-manifest'){
    // This release has no paid Windows certificate. Authenticate the manifest
    // and the exact on-disk bytes before allowing the installer to launch.
    const signed=verifyUpdateSignature(manifest,trust)
    const hash=createHash('sha256');let size=0
    for await(const chunk of createReadStream(path)){hash.update(chunk);size+=chunk.length}
    if(size!==signed.size||hash.digest('hex')!==signed.sha256)throw new Error('安装包与已签名更新信息不匹配，已阻止运行。')
    return
  }
  if(!trust.windowsPublisherSubjects.length)throw new Error('正式安装包发行者尚未配置。')
  const script="$ErrorActionPreference='Stop'; $signature=Get-AuthenticodeSignature -LiteralPath $env:HELLODOG_VERIFY_INSTALLER; [pscustomobject]@{status=[string]$signature.Status;subject=$signature.SignerCertificate.Subject;timestamped=($null -ne $signature.TimeStamperCertificate)} | ConvertTo-Json -Compress"
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:16384,env:{...process.env,HELLODOG_VERIFY_INSTALLER:path}})
  let result:unknown;try{result=JSON.parse(stdout.trim())}catch{throw new Error('安装包发行者验证失败。')}
  if(!validWindowsSignature(result,trust))throw new Error('安装包签名或发行者不受信任，已阻止运行。')
}
