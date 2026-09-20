import { createHash } from 'crypto'

type DispatchRow = {
  owner: string; windowId: string; conversationId: string; requestId: string
  originalHash: string; translatedHash: string; state: 'uncertain' | 'sent' | 'not-sent'
  migratedTextHash?: string
  newRecipient?: boolean; mediaKey?: string
  createdAt: number; resolvedAt?: number; attempts: number
}
export type GoogleVoiceDispatchData = { records: DispatchRow[] }
type Storage = { read(): Promise<GoogleVoiceDispatchData>; write(value: GoogleVoiceDispatchData): Promise<void> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export class GoogleVoiceDispatchScopeError extends Error {
  constructor() { super('请返回“发送新短信”，重新选择原来的收件人并恢复原草稿，核对为未发送后重试。当前会话无法恢复原翻译回执，已保留待确认记录，未新增扣费。') }
}

/** Persist before permitting the browser click. Lost replies never permit replay.
 * This journal records an attempted submission, not proof of SMS delivery.
 * It deliberately stores fingerprints rather than message bodies.
 */
export class GoogleVoiceDispatchLedger {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private storage: Storage) {}
  private transact<T>(authorized: () => boolean, operation: (data: GoogleVoiceDispatchData) => T): Promise<T> {
    const work = this.writes.catch(() => undefined).then(async () => {
      if (!authorized()) throw new Error('登录状态已变化。')
      const data = await this.storage.read()
      if (!authorized() || !Array.isArray(data.records)) throw new Error('发送记录暂时无法核对。')
      const result = operation(data)
      await this.storage.write(data)
      if (!authorized()) throw new Error('登录状态已变化；请核对发送记录。')
      return result
    })
    this.writes = work
    return work
  }
  async snapshot(owner: string, windowId: string, conversationId: string, authorized: () => boolean) {
    await this.writes.catch(() => undefined)
    if (!authorized()) throw new Error('登录状态已变化。')
    const data = await this.storage.read()
    if (!authorized() || !Array.isArray(data.records)) throw new Error('发送记录暂时无法核对。')
    return structuredClone(data.records.filter(row => row.owner === owner && row.windowId === windowId && row.conversationId === conversationId))
  }
  async status(owner: string, windowId: string, conversationId: string, text: string, authorized: () => boolean, mediaKey?: string) {
    await this.writes.catch(() => undefined)
    const data = await this.storage.read()
    if (!authorized() || !Array.isArray(data.records)) throw new Error('发送记录暂时无法核对。')
    const originalHash = digest(text)
    const row = data.records.find(row => row.owner === owner && row.windowId === windowId &&
      (row.conversationId === conversationId || row.newRecipient === true && row.mediaKey === mediaKey) &&
      (row.originalHash === originalHash || row.translatedHash === originalHash) && row.state === 'uncertain')
    return row ? { state: 'uncertain' as const, requestId: row.requestId, attempt: row.attempts, createdAt: row.createdAt } : { state: 'clear' as const }
  }
  reserve(owner: string, windowId: string, conversationId: string, requestId: string, text: string, translated: string, authorized: () => boolean, migratedTextHash?: string, newRecipient = false, mediaKey?: string) {
    if (migratedTextHash !== undefined && !/^[a-f0-9]{64}$/.test(migratedTextHash)) throw new Error('旧草稿指纹无效。')
    if (mediaKey !== undefined && !/^[a-f0-9]{64}$/.test(mediaKey)) throw new Error('图片指纹无效。')
    return this.transact(authorized, data => {
      const scoped = data.records.filter(row => row.owner === owner && row.windowId === windowId && row.conversationId === conversationId)
      const originalHash = digest(text), translatedHash = digest(translated)
      // First sends change Google's URL from itemId=draft to a server-created
      // thread. Keep their unknown attempt visible after navigation/restart,
      // without guessing a thread ID or persisting recipient phone numbers.
      if (data.records.some(row => row.owner === owner && row.windowId === windowId &&
        (row.conversationId === conversationId || row.newRecipient === true && row.mediaKey === mediaKey) &&
        (row.originalHash === originalHash || row.translatedHash === originalHash) && row.state === 'uncertain')) throw new Error('此短信的发送结果待确认，请先核对，不能重复发送。')
      const previous = scoped.find(row => row.requestId === requestId)
      if (previous && (previous.state !== 'not-sent' || previous.originalHash !== originalHash || previous.translatedHash !== translatedHash)) throw new Error('此发送授权已经使用，请核对发送记录。')
      if (previous) {
        previous.state = 'uncertain'; previous.createdAt = Date.now(); previous.attempts++
        if (migratedTextHash) previous.migratedTextHash = migratedTextHash
        delete previous.resolvedAt
      } else data.records.push({ owner, windowId, conversationId, requestId, originalHash, translatedHash, state: 'uncertain', createdAt: Date.now(), attempts: 1, ...(migratedTextHash ? { migratedTextHash } : {}), ...(newRecipient ? { newRecipient: true } : {}), ...(mediaKey ? { mediaKey } : {}) })
      return { authorized: true as const, requestId, attempt: previous?.attempts || 1 }
    })
  }
  resolve(owner: string, windowId: string, conversationId: string, requestId: string, attempt: number, outcome: 'sent' | 'not-sent', authorized: () => boolean, mediaKey?: string) {
    return this.transact(authorized, data => {
      const row = data.records.find(row => row.owner === owner && row.windowId === windowId && (row.conversationId === conversationId || row.newRecipient === true && row.mediaKey === mediaKey) && row.requestId === requestId)
      if (!row) throw new Error('没有对应的待确认发送记录。')
      if (!Number.isSafeInteger(attempt) || attempt < 1 || row.attempts !== attempt) throw new Error('发送次数已变化，请重新核对当前记录。')
      // A changed thread has no verified recipient alias to the original paid
      // draft. Clearing its uncertainty here would allocate a new billable ID.
      // Only the original recipient draft can unlock retry; confirmed delivery
      // may still be recorded from the new official thread.
      if (outcome === 'not-sent' && row.conversationId !== conversationId) throw new GoogleVoiceDispatchScopeError()
      // A saved resolution may lose its reply if the relay disconnects. Replay
      // the same decision successfully; never reverse an already saved one.
      if (row.state === outcome) return { resolved: true as const }
      if (row.state !== 'uncertain') throw new Error('发送结果已核对，不能改为相反结果。')
      row.state = outcome; row.resolvedAt = Date.now()
      return { resolved: true as const }
    })
  }
}
