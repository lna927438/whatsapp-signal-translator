import { createHash } from 'crypto'

type DispatchRow = {
  owner: string; windowId: string; conversationId: string; requestId: string
  originalHash: string; translatedHash: string; state: 'uncertain' | 'sent' | 'not-sent'
  migratedTextHash?: string
  createdAt: number; resolvedAt?: number; attempts: number
}
export type GoogleVoiceDispatchData = { records: DispatchRow[] }
type Storage = { read(): Promise<GoogleVoiceDispatchData>; write(value: GoogleVoiceDispatchData): Promise<void> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

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
  async status(owner: string, windowId: string, conversationId: string, text: string, authorized: () => boolean) {
    await this.writes.catch(() => undefined)
    const data = await this.storage.read()
    if (!authorized() || !Array.isArray(data.records)) throw new Error('发送记录暂时无法核对。')
    const originalHash = digest(text)
    const row = data.records.find(row => row.owner === owner && row.windowId === windowId && row.conversationId === conversationId && (row.originalHash === originalHash || row.translatedHash === originalHash) && row.state === 'uncertain')
    return row ? { state: 'uncertain' as const, requestId: row.requestId, attempt: row.attempts, createdAt: row.createdAt } : { state: 'clear' as const }
  }
  reserve(owner: string, windowId: string, conversationId: string, requestId: string, text: string, translated: string, authorized: () => boolean, migratedTextHash?: string) {
    if (migratedTextHash !== undefined && !/^[a-f0-9]{64}$/.test(migratedTextHash)) throw new Error('旧草稿指纹无效。')
    return this.transact(authorized, data => {
      const scoped = data.records.filter(row => row.owner === owner && row.windowId === windowId && row.conversationId === conversationId)
      const originalHash = digest(text), translatedHash = digest(translated)
      if (scoped.some(row => (row.originalHash === originalHash || row.translatedHash === originalHash) && row.state === 'uncertain')) throw new Error('此短信的发送结果待确认，请先核对，不能重复发送。')
      const previous = scoped.find(row => row.requestId === requestId)
      if (previous && (previous.state !== 'not-sent' || previous.originalHash !== originalHash || previous.translatedHash !== translatedHash)) throw new Error('此发送授权已经使用，请核对发送记录。')
      if (previous) {
        previous.state = 'uncertain'; previous.createdAt = Date.now(); previous.attempts++
        if (migratedTextHash) previous.migratedTextHash = migratedTextHash
        delete previous.resolvedAt
      } else data.records.push({ owner, windowId, conversationId, requestId, originalHash, translatedHash, state: 'uncertain', createdAt: Date.now(), attempts: 1, ...(migratedTextHash ? { migratedTextHash } : {}) })
      return { authorized: true as const, requestId, attempt: previous?.attempts || 1 }
    })
  }
  resolve(owner: string, windowId: string, conversationId: string, requestId: string, attempt: number, outcome: 'sent' | 'not-sent', authorized: () => boolean) {
    return this.transact(authorized, data => {
      const row = data.records.find(row => row.owner === owner && row.windowId === windowId && row.conversationId === conversationId && row.requestId === requestId)
      if (!row) throw new Error('没有对应的待确认发送记录。')
      if (!Number.isSafeInteger(attempt) || attempt < 1 || row.attempts !== attempt) throw new Error('发送次数已变化，请重新核对当前记录。')
      // A saved resolution may lose its reply if the relay disconnects. Replay
      // the same decision successfully; never reverse an already saved one.
      if (row.state === outcome) return { resolved: true as const }
      if (row.state !== 'uncertain') throw new Error('发送结果已核对，不能改为相反结果。')
      row.state = outcome; row.resolvedAt = Date.now()
      return { resolved: true as const }
    })
  }
}
