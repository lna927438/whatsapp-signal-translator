import { createHash } from 'crypto'
import { JsonStore } from './jsonStore'

type Note = { text: string; revision: number }
export class ContactNotes {
  private store = new JsonStore<Record<string, Note>>('contact-notes-v1.json', {}, true)
  private writes: Promise<unknown> = Promise.resolve()
  private key(owner: string, account: string, peer: string) {
    if (!owner || typeof account !== 'string' || !account || account.length > 160
      || typeof peer !== 'string' || !/^peer:[^\s<>]{1,180}@[a-zA-Z0-9.-]{1,40}$/.test(peer)) throw new Error('暂时无法确认此联系人的身份，请等待聊天记录加载后重试。')
    return createHash('sha256').update(JSON.stringify([owner, account, peer])).digest('hex')
  }
  async get(owner: string, account: string, peer: string): Promise<Note> {
    const key = this.key(owner, account, peer)
    await this.writes.catch(() => undefined)
    return (await this.store.read())[key] || { text: '', revision: 0 }
  }
  save(owner: string, account: string, peer: string, text: string, revision: number): Promise<Note> {
    const key = this.key(owner, account, peer)
    if (typeof text !== 'string' || text.length > 500 || !Number.isSafeInteger(revision) || revision < 0) throw new Error('联系人备注最多 500 个字符。')
    const work = this.writes.catch(() => undefined).then(async () => {
      const entries = await this.store.read()
      if ((entries[key]?.revision || 0) !== revision) throw new Error('备注已在另一处修改，请重新打开查看后再保存。')
      const note = { text: text.trim(), revision: revision + 1 }
      entries[key] = note
      await this.store.write(entries)
      return note
    })
    this.writes = work
    return work
  }
}
