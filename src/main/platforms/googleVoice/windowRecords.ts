import { randomUUID, createHash } from 'crypto'
import { join } from 'path'
import { safeStorage } from 'electron'
import type { AccountProxy } from '../../network/accountProxy'
import { normalizeGoogleVoiceProxy } from './network'
import type { GoogleVoiceBrowser } from './officialWindow'
import { translationChannel, type TranslationChannel } from '../../../shared/translationChannels'

export interface GoogleVoiceRecord {
  id: string; owner: string; label: string; tabOrder: number; createdAt: number
  browser?: GoogleVoiceBrowser; closed?: boolean; notificationsEnabled?: boolean
  proxy?: AccountProxy; proxySecret?: string
  translationProvider?: TranslationChannel
}
export type GoogleVoicePublicRecord = Omit<GoogleVoiceRecord, 'proxySecret'>
export type GoogleVoiceData = { windows: GoogleVoiceRecord[] }
type Storage = { read(): Promise<GoogleVoiceData>; write(data: GoogleVoiceData): Promise<void> }
const validId = (id: unknown): id is string => typeof id === 'string' && /^gv-[a-f0-9-]{36}$/.test(id)
export const googleVoiceProfileRoot = (root: string, owner: string, id: string) => {
  if (!owner || !validId(id)) throw new Error('Google Voice 窗口无效。')
  // 128-bit path identifiers match the existing desktop profile convention and
  // leave room for Chromium's nested filenames on Windows installations.
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0,32)
  return join(root, 'google-voice-windows', hash(owner), hash(id))
}

/** Serializes read-modify-write and never removes a browser profile. */
export class GoogleVoiceRecords {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private storage: Storage) {}
  private transact<T>(operation: (data: GoogleVoiceData) => T): Promise<T> {
    const work = this.writes.catch(() => undefined).then(async () => {
      const data = await this.storage.read()
      if (!Array.isArray(data.windows)) throw new Error('Google Voice 窗口记录无法读取。')
      const result = operation(data); await this.storage.write(data); return structuredClone(result)
    })
    this.writes = work; return work
  }
  private publicRecord(row: GoogleVoiceRecord): GoogleVoicePublicRecord {
    const { proxySecret, proxy, ...publicRow } = row
    return { ...publicRow, ...(proxy ? { proxy: { ...normalizeGoogleVoiceProxy(proxy), hasPassword: Boolean(proxySecret) } } : {}) }
  }
  private label(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 60 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('名称须为 1–60 个可见字符。')
    return value.trim()
  }
  private prepareProxyInput(input: any, current?: GoogleVoiceRecord) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('代理设置无效。')
    const existing = current?.proxy, oldSecret = current?.proxySecret || ''
    const clear = input.clearPassword === true
    const proxy = normalizeGoogleVoiceProxy({ ...existing, ...input, hasPassword: Boolean(oldSecret) && !clear })
    const replacement = typeof input.password === 'string' && input.password.length > 0 && !clear
    const changed = Boolean(existing && ['protocol', 'host', 'port', 'username'].some(key => (existing as any)[key] !== (proxy as any)[key]))
    if (oldSecret && changed && !replacement && !clear) throw new Error('更换代理地址、端口或账号后，请重新填写密码；免密码代理请勾选清除密码。')
    return { proxy, replacement, clear, oldSecret }
  }
  private proxyPatch(input: any, current?: GoogleVoiceRecord): Pick<GoogleVoiceRecord, 'proxy' | 'proxySecret'> {
    const { proxy, replacement, clear, oldSecret } = this.prepareProxyInput(input, current)
    let proxySecret = clear ? '' : oldSecret
    if (replacement) {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('系统安全存储不可用，无法保存代理密码。')
      try { proxySecret = safeStorage.encryptString(input.password).toString('base64') }
      catch { throw new Error('代理密码加密失败，原设置已保留。') }
    }
    return { proxy: { ...proxy, hasPassword: Boolean(proxySecret) }, proxySecret }
  }
  private decryptProxySecret(secret?: string): string {
    if (!secret) return ''
    try {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error()
      return safeStorage.decryptString(Buffer.from(secret, 'base64'))
    } catch { throw new Error('代理密码无法解密，请重新填写后保存。') }
  }
  /** Main-process-only: reuse the saved password only for the unchanged endpoint. */
  async proxyForTest(owner: string, id: string | undefined, input: any): Promise<{ proxy: AccountProxy; password: string }> {
    if (!owner) throw new Error('请先登录 HelloDog。')
    await this.writes.catch(() => undefined)
    const row = id === undefined ? undefined : (await this.storage.read()).windows.find(item => item.owner === owner && item.id === id && !item.closed)
    if (id !== undefined && (!row || !validId(id))) throw new Error('Google Voice 窗口不存在。')
    const { proxy, replacement, clear, oldSecret } = this.prepareProxyInput(input, row)
    const password = clear ? '' : replacement ? input.password : this.decryptProxySecret(oldSecret)
    return { proxy: { ...proxy, hasPassword: Boolean(password) }, password }
  }
  async list(owner: string): Promise<GoogleVoicePublicRecord[]> {
    if (!owner) throw new Error('请先登录 HelloDog。')
    await this.writes.catch(() => undefined)
    return (await this.storage.read()).windows.filter(row => row.owner === owner && !row.closed).sort((a,b) => a.tabOrder-b.tabOrder).map(row => this.publicRecord(row))
  }
  async get(owner: string, id: string) {
    const record = (await this.list(owner)).find(row => row.id === id)
    if (!validId(id) || !record) throw new Error('Google Voice 窗口不存在。')
    return record
  }
  async proxyPassword(owner: string, id: string): Promise<string> {
    if (!owner) throw new Error('请先登录 HelloDog。')
    await this.writes.catch(() => undefined)
    const row = (await this.storage.read()).windows.find(item => item.owner === owner && item.id === id && !item.closed)
    if (!row || !validId(id)) throw new Error('Google Voice 窗口不存在。')
    return this.decryptProxySecret(row.proxySecret)
  }
  add(owner: string, options: { label?: string; proxy?: any; translationProvider?: TranslationChannel } = {}) {
    if (!owner) return Promise.reject(new Error('请先登录 HelloDog。'))
    if (!options || typeof options !== 'object' || Array.isArray(options)) return Promise.reject(new Error('Google Voice 窗口设置无效。'))
    return this.transact(data => {
      const rows = data.windows.filter(row => row.owner === owner && !row.closed)
      if (rows.length >= 20) throw new Error('最多可添加 20 个 Google Voice 窗口。')
      const row: GoogleVoiceRecord = { id:'gv-'+randomUUID(),owner,label:options.label === undefined ? 'Google Voice '+(rows.length+1) : this.label(options.label),tabOrder:rows.length,createdAt:Date.now() }
      if (options.translationProvider !== undefined) row.translationProvider=translationChannel(options.translationProvider)
      if (options.proxy !== undefined) Object.assign(row, this.proxyPatch(options.proxy))
      data.windows.push(row); return this.publicRecord(row)
    })
  }
  update(owner: string, id: string, patch: {label?: string; browser?: GoogleVoiceBrowser; closed?: boolean; proxy?: any; notificationsEnabled?: boolean; translationProvider?: TranslationChannel}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return Promise.reject(new Error('Google Voice 窗口设置无效。'))
    return this.transact(data => {
      const row = data.windows.find(row => row.owner === owner && row.id === id && !row.closed)
      if (!row || !validId(id)) throw new Error('Google Voice 窗口不存在。')
      if(patch.translationProvider!==undefined)row.translationProvider=translationChannel(patch.translationProvider)
      if (patch.notificationsEnabled !== undefined) {
        if (typeof patch.notificationsEnabled !== 'boolean') throw new Error('通知设置无效。')
        row.notificationsEnabled = patch.notificationsEnabled
      }
      const proxyPatch = patch.proxy === undefined ? undefined : this.proxyPatch(patch.proxy, row)
      if (patch.label !== undefined) row.label = this.label(patch.label)
      if (patch.browser) {
        if (!['chrome','edge'].includes(patch.browser) || row.browser && row.browser !== patch.browser) throw new Error('已绑定的浏览器不能自动更换。')
        row.browser = patch.browser
      }
      if (patch.closed === true) row.closed = true
      if (proxyPatch) Object.assign(row, proxyPatch)
      return this.publicRecord(row)
    })
  }
  reorder(owner: string, ids: string[]) {
    return this.transact(data => {
      const rows = data.windows.filter(row => row.owner === owner && !row.closed)
      if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => !rows.some(row => row.id === id))) throw new Error('窗口排序已变化，请刷新后重试。')
      ids.forEach((id,index) => { rows.find(row => row.id === id)!.tabOrder = index }); return rows.sort((a,b) => a.tabOrder-b.tabOrder).map(row => this.publicRecord(row))
    })
  }
}
