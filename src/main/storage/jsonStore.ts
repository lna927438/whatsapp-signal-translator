import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

const protectedFiles = new Set(['online-auth-v1.json', 'translation-content-policy-v1.json', 'drafts-v1.json', 'outgoing-tasks-v1.json', 'translation-receipts-v1.json', 'message-requests-v1.json', 'translation-cache.json', 'signal-history-v1.json'])
protectedFiles.add('contact-notes-v1.json')
const pendingWrites = new Map<string, Promise<void>>()
const encryptedPrefix = 'hellodog-encrypted-v1:'

export class JsonStore<T> {
  constructor(private readonly fileName: string, private readonly defaults: T, private readonly strictRead = false) {}

  private get filePath(): string {
    return join(app.getPath('userData'), this.fileName)
  }

  async read(): Promise<T> {
    await pendingWrites.get(this.filePath)?.catch(() => undefined)
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      if (text.startsWith(encryptedPrefix)) {
        try { return JSON.parse(safeStorage.decryptString(Buffer.from(text.slice(encryptedPrefix.length), 'base64'))) as T }
        catch { throw new Error('本机加密记录无法解锁，请使用原 Windows 用户打开，勿清空恢复记录。') }
      }
      const parsed=JSON.parse(text) as T
      if (protectedFiles.has(this.fileName)) { await this.encryptLegacy(text); return this.read() }
      return parsed
    } catch (error: any) {
      // A damaged send ledger must never look like an empty ledger: doing so
      // would permit a second platform submission with a new request ID.
      if ((this.strictRead || protectedFiles.has(this.fileName)) && error?.code !== 'ENOENT') throw new Error('无法读取已保存的记录，请使用原 Windows 用户并保留应用数据后重试。')
      return structuredClone(this.defaults)
    }
  }

  private async encryptLegacy(expected: string): Promise<void> {
    const path=this.filePath
    const work=(pendingWrites.get(path)||Promise.resolve()).catch(()=>undefined).then(async()=>{
      const current=await fs.readFile(path,'utf8')
      if(current!==expected)return
      if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密暂不可用，旧记录已保留，尚未迁移。')
      const text=encryptedPrefix+safeStorage.encryptString(current).toString('base64'),tmp=path+'.tmp'
      const handle=await fs.open(tmp,'w',0o600)
      try{await handle.writeFile(text,'utf8');await handle.sync()}finally{await handle.close()}
      await fs.rename(tmp,path)
    })
    pendingWrites.set(path,work)
    try{await work}finally{if(pendingWrites.get(path)===work)pendingWrites.delete(path)}
  }

  async write(value: T): Promise<void> {
    const path = this.filePath
    const json = JSON.stringify(value, null, 2)
    const work = (pendingWrites.get(path) || Promise.resolve()).catch(() => undefined).then(async () => {
      let text = json
      if (protectedFiles.has(this.fileName)) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密暂不可用，记录尚未保存，请保留输入并稍后重试。')
        text = encryptedPrefix + safeStorage.encryptString(json).toString('base64')
      }
      await fs.mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      const handle = await fs.open(tmp, 'w', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      await fs.rename(tmp, path)
    })
    pendingWrites.set(path, work)
    try { await work } finally { if (pendingWrites.get(path) === work) pendingWrites.delete(path) }
  }
}
