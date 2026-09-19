import { randomUUID, createHash } from 'crypto'
import { join } from 'path'
import type { GoogleVoiceBrowser } from './officialWindow'

export interface GoogleVoiceRecord {
  id: string; owner: string; label: string; tabOrder: number; createdAt: number
  browser?: GoogleVoiceBrowser; closed?: boolean
}
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
  async list(owner: string): Promise<GoogleVoiceRecord[]> {
    if (!owner) throw new Error('请先登录 HelloDog。')
    await this.writes.catch(() => undefined)
    return (await this.storage.read()).windows.filter(row => row.owner === owner && !row.closed).sort((a,b) => a.tabOrder-b.tabOrder)
  }
  async get(owner: string, id: string) {
    const record = (await this.list(owner)).find(row => row.id === id)
    if (!validId(id) || !record) throw new Error('Google Voice 窗口不存在。')
    return record
  }
  add(owner: string) {
    if (!owner) return Promise.reject(new Error('请先登录 HelloDog。'))
    return this.transact(data => {
      const rows = data.windows.filter(row => row.owner === owner && !row.closed)
      if (rows.length >= 20) throw new Error('最多可添加 20 个 Google Voice 窗口。')
      const row: GoogleVoiceRecord = { id:'gv-'+randomUUID(),owner,label:'Google Voice '+(rows.length+1),tabOrder:rows.length,createdAt:Date.now() }
      data.windows.push(row); return row
    })
  }
  update(owner: string, id: string, patch: {label?: string; browser?: GoogleVoiceBrowser; closed?: boolean}) {
    return this.transact(data => {
      const row = data.windows.find(row => row.owner === owner && row.id === id && !row.closed)
      if (!row || !validId(id)) throw new Error('Google Voice 窗口不存在。')
      if (patch.label !== undefined) {
        if (typeof patch.label !== 'string' || !patch.label.trim() || Array.from(patch.label).length > 60 || /[\x00-\x1f\x7f]/.test(patch.label)) throw new Error('名称须为 1–60 个可见字符。')
        row.label = patch.label.trim()
      }
      if (patch.browser) {
        if (!['chrome','edge'].includes(patch.browser) || row.browser && row.browser !== patch.browser) throw new Error('已绑定的浏览器不能自动更换。')
        row.browser = patch.browser
      }
      if (patch.closed === true) row.closed = true
      return row
    })
  }
  reorder(owner: string, ids: string[]) {
    return this.transact(data => {
      const rows = data.windows.filter(row => row.owner === owner && !row.closed)
      if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => !rows.some(row => row.id === id))) throw new Error('窗口排序已变化，请刷新后重试。')
      ids.forEach((id,index) => { rows.find(row => row.id === id)!.tabOrder = index }); return rows.sort((a,b) => a.tabOrder-b.tabOrder)
    })
  }
}
