import { createHash, randomUUID } from 'crypto'
import { JsonStore } from './jsonStore'
import { normalizeSignalPeer } from '../../shared/signalProtocol'
import { signalPreferenceDefaults, signalPreferencePatch, signalConversationPatch, type SignalPreferences } from '../../shared/signalPreferences'

export class SignalPreferencesStore {
  private store = new JsonStore<Record<string, SignalPreferences>>('signal-preferences-v1.json', {}, true)
  private writes: Promise<unknown> = Promise.resolve()
  private key(owner: string, account: string) {
    if (!owner || !account) throw new Error('Signal 账号不可用。')
    return createHash('sha256').update(JSON.stringify([owner, account])).digest('hex')
  }
  async get(owner: string, account: string): Promise<SignalPreferences> {
    await this.writes.catch(() => undefined)
    return { ...structuredClone(signalPreferenceDefaults), ...(await this.store.read())[this.key(owner, account)] }
  }
  private change(owner: string, account: string, run: (current: SignalPreferences) => void) {
    const key = this.key(owner, account)
    const work = this.writes.catch(() => undefined).then(async () => {
      const data = await this.store.read()
      const current = { ...structuredClone(signalPreferenceDefaults), ...data[key] }
      run(current); data[key] = current; await this.store.write(data)
      return structuredClone(current)
    })
    this.writes = work; return work
  }
  save(owner: string, account: string, value: unknown) {
    const patch = signalPreferencePatch(value)
    return this.change(owner, account, current => Object.assign(current, patch))
  }
  conversation(owner: string, account: string, peer: string, value: unknown) {
    const id = normalizeSignalPeer(peer), patch = signalConversationPatch(value)
    return this.change(owner, account, current => { current.conversations[id] = { ...current.conversations[id], ...patch } })
  }
  folder(owner: string, account: string, value: { id?: string; name?: string; peers?: string[]; remove?: boolean }) {
    return this.change(owner, account, current => {
      if (value.remove) { current.folders = current.folders.filter(folder => folder.id !== value.id); return }
      const name = String(value.name || '').trim()
      if (!name || name.length > 30 || !Array.isArray(value.peers) || value.peers.length > 1000) throw new Error('请输入文件夹名称并选择聊天。')
      const folder = { id: value.id || randomUUID(), name, peers: [...new Set(value.peers.map(normalizeSignalPeer))] }
      const index = current.folders.findIndex(item => item.id === folder.id)
      if (index >= 0) current.folders[index] = folder
      else { if (current.folders.length >= 20) throw new Error('最多创建 20 个聊天文件夹。'); current.folders.push(folder) }
    })
  }
}
