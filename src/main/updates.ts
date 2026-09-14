import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, stat, open, rename } from 'fs/promises'
import { join, dirname, basename } from 'path'
import { app, shell } from 'electron'
import { JsonStore } from './storage/jsonStore'
import { createUpdateRecovery } from './storage/updateRecovery'
import { trustedUpdate, verifyWindowsInstaller } from './updateTrust'
import type { SignedUpdate } from '../shared/updateSignature'
export interface UpdateManifest { version: string; versionKey: string; sha256: string; size: number; channel: 'stable' | 'beta'; notes: string; schemaVersion?:1; issuedAt?:string; expiresAt?:string; sourceCommit?:string; signature?:SignedUpdate['signature'] }
/** Unknown versions are never treated as an upgrade. Stable sorts after its prereleases. */
export function compareVersions(left: string, right: string): number | undefined {
  const parse=(v:string)=>v.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/)
  const a=parse(left),b=parse(right);if(!a||!b)return undefined
  for(let i=1;i<=3;i++){const x=Number(a[i]),y=Number(b[i]);if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y))return undefined;if(x!==y)return x>y?1:-1}
  const rank=(name:string|undefined)=>({alpha:0,beta:1,rc:2}[name||'']??3)
  if(rank(a[4])!==rank(b[4]))return rank(a[4])>rank(b[4])?1:-1
  const x=Number(a[5]||0),y=Number(b[5]||0);if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y))return undefined
  return x===y?0:x>y?1:-1
}
export function supportsProtectedRecords(version: string): boolean {
  const order=compareVersions(version,'0.5.3-beta.2');return order!==undefined&&order>=0
}
export function validateManifest(value: any, channel: 'stable' | 'beta'): UpdateManifest {
  if (typeof value?.version !== 'string' || !/^v?\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(value.version)
    || (value.version.includes('-beta') ? 'beta' : 'stable') !== channel
    || typeof value.versionKey !== 'string' || !/^windows\/(?:beta\/)?v[\d.]+(?:-beta\.\d+)?\/[\w.\-]+\.exe$/.test(value.versionKey)
    || !/^[a-f0-9]{64}$/i.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 512 * 1024 * 1024) throw new Error('更新信息校验失败。')
  return { version: value.version.replace(/^v/, ''), versionKey: value.versionKey, sha256: value.sha256.toLowerCase(), size: value.size, channel, notes: typeof value.notes === 'string' ? value.notes.slice(0, 10000) : '此版本未提供详细更新说明。', ...(value.signature ? { schemaVersion:value.schemaVersion,issuedAt:value.issuedAt,expiresAt:value.expiresAt,signature:value.signature,sourceCommit:value.sourceCommit } : {}) }
}
async function readManifest(response:Response,channel:'stable'|'beta'){
  const reader=response.body?.getReader();if(!reader)throw new Error('更新内容为空。')
  let text='',size=0;const decoder=new TextDecoder()
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536){await reader.cancel();throw new Error('更新信息过大。')}text+=decoder.decode(next.value,{stream:true})}text+=decoder.decode()}
  finally{reader.releaseLock()}
  return validateManifest(await trustedUpdate(JSON.parse(text)),channel)
}
export async function fileHash(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
/** Fixed destination supplied by the app; untrusted manifests never choose a local path. */
export async function downloadVerified(url: string, destination: string, manifest: Pick<UpdateManifest, 'size' | 'sha256'>, progress: (bytes: number) => void = () => undefined) {
  const part = destination + '.part'
  let offset = await stat(part).then(value => value.size).catch(() => 0)
  if (offset > manifest.size) { const file = await open(part, 'w'); await file.close(); offset = 0 }
  if (offset < manifest.size) {
    const response = await fetch(url, { redirect:'error', headers: offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(300000) })
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
      if (!range || Number(range[1]) !== offset || Number(range[3]) !== manifest.size || Number(range[2]) !== manifest.size - 1) throw new Error('下载续传范围不一致，请重试。')
    } else if (response.status === 200) offset = 0
    else throw new Error(`下载暂时不可用 (${response.status})，已保留下载进度。`)
    if (!response.body) throw new Error('下载内容为空。')
    const file = await open(part, offset ? 'a' : 'w')
    try {
      const reader = response.body.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value
        if (offset + chunk.byteLength > manifest.size) throw new Error('下载文件大小超过版本记录。')
        let written = 0
        while (written < chunk.byteLength) written += (await file.write(chunk, written, chunk.byteLength - written)).bytesWritten
        offset += chunk.byteLength; progress(offset)
      }
      await file.sync()
    } finally { await file.close() }
  }
  if (offset !== manifest.size) throw new Error('下载尚未完成，进度已保留，可继续下载。')
  if (await fileHash(part) !== manifest.sha256) {
    // Quarantine corrupt bytes so a retry starts cleanly and never launches them.
    await rename(part, part + '.invalid-' + Date.now())
    throw new Error('安装包校验失败，已隔离文件，请重新下载。')
  }
  await rename(part, destination)
  return destination
}
export class UpdateManager {
  private state = new JsonStore<{ manifest?: UpdateManifest; highestTrustedVersion?:string; phase?: string; previousVersion?: string; recoveryDirectory?: string }>('update-state.json', {}, true)
  private notices = new JsonStore<{ checkedAt?:number; latest?:UpdateManifest; snoozedVersion?:string; snoozedUntil?:number }>('update-notice.json', {})
  private noticeWork?: Promise<unknown>
  private nextNoticeAttempt=0
  private busy = false
  private received = 0
  private error = ''
  private root() { return join(app.getPath('userData'), 'verified-updates') }
  async notice() {
    const saved=await this.notices.read(),now=Date.now()
    if(now>=this.nextNoticeAttempt && (!saved.checkedAt || now-saved.checkedAt>=10*60000)) {
      if(!this.noticeWork)this.noticeWork=(async()=>{
        try {
          const response=await fetch('https://download.hellodog.net/metadata/version.json',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)})
          if(!response.ok)throw new Error('update-unavailable')
          const latest=await readManifest(response,'stable')
          const current=await this.notices.read()
          if(current.latest&&compareVersions(latest.version,current.latest.version)===-1)throw new Error('更新版本回退已被阻止。')
          await this.notices.write({...current,latest,checkedAt:Date.now()});this.nextNoticeAttempt=Date.now()+10*60000
        } catch { this.nextNoticeAttempt=Date.now()+30*60000 }
      })().finally(()=>{this.noticeWork=undefined})
      await this.noticeWork
    }
    const current=await this.notices.read()
    const available=!!current.latest && compareVersions(current.latest.version,app.getVersion())===1
    return {currentVersion:app.getVersion(),latestVersion:current.latest?.version,notes:current.latest?.notes,checkedAt:current.checkedAt,
      available,show:available && (current.snoozedVersion!==current.latest?.version || (current.snoozedUntil||0)<=Date.now()),website:'https://hellodog.net/download'}
  }
  async snooze(version:string) {
    if(this.noticeWork)await this.noticeWork
    const current=await this.notices.read()
    if(version!==current.latest?.version)throw new Error('版本信息已变化，请重新检查。')
    await this.notices.write({...current,snoozedVersion:version,snoozedUntil:Date.now()+86400000})
    return this.notice()
  }
  async info() {
    const saved = await this.state.read()
    if (!this.busy && saved.manifest) {
      const path = join(this.root(), saved.manifest.sha256 + '.exe')
      this.received = await stat(path + '.part').then(value => value.size).catch(() => stat(path).then(value => value.size).catch(() => 0))
    }
    return { currentVersion: app.getVersion(), ...saved, newer:!!saved.manifest && compareVersions(saved.manifest.version,app.getVersion())===1, phase: saved.phase === 'opened' && saved.manifest?.version === app.getVersion() ? 'installed' : saved.phase, busy: this.busy, received: this.received, error: this.error }
  }
  async check(channel: 'stable' | 'beta') {
    const path = channel === 'beta' ? 'metadata/beta/version.json' : 'metadata/version.json'
    const response = await fetch('https://download.hellodog.net/' + path, { redirect:'error', cache: 'no-store', signal: AbortSignal.timeout(12000) })
    if (response.status === 404 && channel === 'beta') throw new Error('暂无已发布的测试版。本地测试包不会自动上线。')
    if (!response.ok) throw new Error('暂时无法读取更新信息。')
    const manifest = await readManifest(response, channel)
    if(compareVersions(manifest.version,app.getVersion())!==1)throw new Error('当前已是此渠道的最新版本，或本机版本更新。')
    if (!supportsProtectedRecords(manifest.version)) throw new Error('此版本早于本机加密记录格式，不能直接降级。请等待兼容此格式的新版本。')
    if (this.busy) throw new Error('请等待当前下载完成。')
    const previous = await this.state.read()
    if(previous.highestTrustedVersion&&compareVersions(manifest.version,previous.highestTrustedVersion)===-1)throw new Error('更新版本低于已验证的版本，已阻止回退。')
    if(previous.manifest?.sha256===manifest.sha256 && previous.manifest.version===manifest.version)return manifest
    await this.state.write({ manifest, highestTrustedVersion:manifest.version, phase: 'available', previousVersion: app.getVersion(), recoveryDirectory: previous.recoveryDirectory })
    return manifest
  }
  async download() {
    if (this.busy) return this.info()
    const saved = await this.state.read()
    if (!saved.manifest) throw new Error('请先检查版本。')
    const manifest = validateManifest(await trustedUpdate(saved.manifest), saved.manifest.channel)
    if(compareVersions(manifest.version,app.getVersion())!==1)throw new Error('已阻止下载相同或更旧的版本。')
    this.busy = true; this.error = ''
    try {
      await mkdir(this.root(), { recursive: true })
      await this.state.write({ ...saved, phase: 'downloading' })
      await downloadVerified('https://download.hellodog.net/' + manifest.versionKey, join(this.root(), manifest.sha256 + '.exe'), manifest, bytes => { this.received = bytes })
      await this.state.write({ ...saved, phase: 'verified' })
    } catch (error) { this.error = error instanceof Error ? error.message : '下载中断，进度已保留。'; await this.state.write({ ...saved, phase: 'interrupted' }); throw error }
    finally { this.busy = false }
    return this.info()
  }
  async openInstaller() {
    const saved = await this.state.read()
    if (!saved.manifest || !['verified', 'opened'].includes(saved.phase || '')) throw new Error('请先完成下载和校验。')
    await trustedUpdate(saved.manifest)
    if(compareVersions(saved.manifest.version,app.getVersion())!==1)throw new Error('此安装包不是更新版本，已阻止降级。')
    if (!supportsProtectedRecords(saved.manifest.version)) throw new Error('此安装包不支持当前加密记录，已阻止降级。')
    const path = join(this.root(), saved.manifest.sha256 + '.exe')
    if (await fileHash(path) !== saved.manifest.sha256) throw new Error('安装包校验失败。')
    await verifyWindowsInstaller(path,saved.manifest)
    if (!app.isPackaged) throw new Error('开发预览不能安装更新，请使用已安装的客户端。')
    const recoveryDirectory = await createUpdateRecovery(dirname(app.getPath('exe')), join(this.root(), 'recovery'), basename(app.getPath('exe')), app.getVersion())
    await this.state.write({ ...saved, recoveryDirectory })
    const error = await shell.openPath(path)
    if (error) throw new Error('安装程序未能启动，原版本与数据已保留，可重试。')
    await this.state.write({ ...saved, recoveryDirectory, phase: 'opened' })
    return true
  }
  async openRecovery() {
    const saved = await this.state.read()
    if (!saved.recoveryDirectory) throw new Error('尚未创建上一版程序恢复副本。')
    const error = await shell.openPath(saved.recoveryDirectory)
    if (error) throw new Error('无法打开恢复目录，请稍后重试。')
    return true
  }
}
