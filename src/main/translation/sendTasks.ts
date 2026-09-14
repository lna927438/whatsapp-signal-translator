import { createHash, randomUUID } from 'crypto'
import type { TranslationRequest } from '../types'
import { hasSignalMedia, mediaIntent, type SignalPayload } from '../../shared/signalMedia'
import { alreadyInTargetLanguage, hasBlockedChinese } from './outgoingPolicy'
import { validateTranslation } from './translationValidation'

export type SendState = 'draft' | 'translating' | 'ready' | 'submitting' | 'uncertain' | 'sent' | 'cancelled'
export interface SendTask {
  id: string
  intentId?: string
  owner: string
  platform: 'whatsapp' | 'signal'
  accountId: string
  conversationId: string
  targetKey?: string
  signalAccount?: string
  recipient?: string
  signalPayload?: SignalPayload
  request: TranslationRequest
  translate: boolean
  blockChinese: boolean
  state: SendState
  translated?: string
  result?: unknown
  createdAt: number
  updatedAt: number
}
export type NewSendTask = Omit<SendTask, 'id' | 'owner' | 'state' | 'createdAt' | 'updatedAt' | 'translated' | 'result'>
type SentOriginal = { owner: string; accountId: string; messageId: string; text: string; original: string; at: number }
export interface SendTaskData { tasks: SendTask[]; originals?: Record<string, SentOriginal> }
const displayText = (text: string) => text.replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim()
const originalKey = (owner: string, accountId: string, messageId: string) => createHash('sha256').update(JSON.stringify([owner, accountId, messageId])).digest('hex')
export interface TaskPersistence { read(): Promise<SendTaskData>; write(data: SendTaskData): Promise<void> }

/** Only throw this when no platform send command has been dispatched. */
export class SendNotStartedError extends Error {}
export class SendPendingError extends Error {
  constructor(public readonly evidence?: unknown) { super('正在后台确认发送结果，可继续聊天。') }
}
const sameTarget = (task: SendTask, targetKey?: string) => task.targetKey === targetKey
  || (Boolean(targetKey?.startsWith('peer:')) && task.targetKey === 'title:' + task.conversationId)

export const uncertainSendMessage = '这条消息正在后台确认，请勿重复发送；可以继续发送其他消息。'

/** Persists the request snapshot before any API call or platform submission. */
export class SendTasks {
  async unfinished(owner: string): Promise<SendTask[]> {
    await this.writes.catch(() => undefined)
    return (await this.storage.read()).tasks.filter(task => task.owner === owner && !['sent', 'cancelled'].includes(task.state))
  }
  async flush() { await this.writes }
  private writes: Promise<unknown> = Promise.resolve()
  private translations = new Map<string, Promise<SendTask>>()
  private submissions = new Map<string, Promise<SendTask>>()
  constructor(private readonly storage: TaskPersistence) {}

  private transaction<T>(run: (data: SendTaskData) => T): Promise<T> {
    const next = this.writes.catch(() => {}).then(async () => {
      const data = await this.storage.read()
      const result = run(data)
      // Keep the message identity after completed tasks age out of the queue.
      // Never restore an original by matching identical text in another message.
      for (const task of data.tasks) {
        const messageId = (task.result as any)?.messageId
        if (task.platform !== 'whatsapp' || task.state !== 'sent' || typeof messageId !== 'string' || !messageId || messageId.startsWith('pre:') || !task.translated) continue
        data.originals ??= {}
        const key = originalKey(task.owner, task.accountId, messageId)
        data.originals[key] = { owner: task.owner, accountId: task.accountId, messageId, text: displayText(task.translated), original: task.request.text, at: task.updatedAt }
      }
      const originals = Object.entries(data.originals || {})
      if (originals.length > 30000) for (const [key] of originals.sort((a,b) => a[1].at-b[1].at).slice(0,5000)) delete data.originals![key]
      await this.storage.write(data)
      return structuredClone(result)
    })
    this.writes = next
    return next
  }

  private owned(data: SendTaskData, owner: string, id: string): SendTask {
    const task = data.tasks.find(item => item.id === id && item.owner === owner)
    if (!owner || !task) throw new Error('发送任务不存在或不属于当前登录账号。')
    return task
  }

  editPreview(owner: string, id: string, text: string): Promise<SendTask> {
    return this.transaction(data => {
      const task = this.owned(data, owner, id)
      if (task.state !== 'ready' || typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('仅可编辑待发送译文。')
      task.translated = text.trim(); task.updatedAt = Date.now()
      return task
    })
  }

  prepare(owner: string, input: NewSendTask): Promise<SendTask> {
    return this.transaction(data => {
      if (!owner || !input.accountId || !input.conversationId || (!input.request.text.trim() && !(input.platform === 'signal' && hasSignalMedia(input.signalPayload)))) {
        throw new Error('无法确认发送账号、对话或草稿，已阻止发送。')
      }
      const text = input.request.text.trim()
      const replay = input.intentId && data.tasks.find(task => task.owner === owner && task.intentId === input.intentId)
      if (replay) {
        if (replay.platform !== input.platform || replay.accountId !== input.accountId || replay.conversationId !== input.conversationId
          || !sameTarget(replay, input.targetKey) || replay.signalAccount !== input.signalAccount || replay.recipient !== input.recipient || replay.request.text !== text || mediaIntent(replay.signalPayload) !== mediaIntent(input.signalPayload)) {
          throw new Error('发送操作与已保存的消息不一致，请重新编辑后发送。')
        }
        return replay
      }
      const unresolved = [...data.tasks].reverse().find(task => task.owner === owner
        && ['uncertain', 'submitting'].includes(task.state) && task.platform === input.platform
        && (!input.intentId || task.intentId === input.intentId)
        && task.accountId === input.accountId && task.conversationId === input.conversationId
        && sameTarget(task, input.targetKey) && task.signalAccount === input.signalAccount && task.request.text === text && mediaIntent(task.signalPayload) === mediaIntent(input.signalPayload))
      if (unresolved) return unresolved
      const previous = [...data.tasks].reverse().find(task => task.owner === owner && !['sent', 'cancelled'].includes(task.state)
        && (!input.intentId || task.intentId === input.intentId)
        && task.platform === input.platform && task.accountId === input.accountId
        && task.conversationId === input.conversationId && task.signalAccount === input.signalAccount
        && sameTarget(task, input.targetKey) && task.recipient === input.recipient
        && task.request.text === text && mediaIntent(task.signalPayload) === mediaIntent(input.signalPayload))
      // Incomplete tasks retain their original language and context, even after
      // renderer reloads or new messages arriving while an API response is lost.
      if (previous) return previous
      const id = `send-${randomUUID()}`
      const now = Date.now()
      const task: SendTask = { ...structuredClone(input), id, owner, state: 'draft',
        request: { ...structuredClone(input.request), text, requestId: id }, createdAt: now, updatedAt: now }
      const completed = data.tasks.filter(item => ['sent', 'cancelled'].includes(item.state)).slice(-200)
      const pending = data.tasks.filter(item => !['sent', 'cancelled'].includes(item.state))
      if (pending.length >= 2000) throw new Error('待处理发送任务过多，请先处理已有草稿。')
      data.tasks = [...completed, ...pending, task]
      return task
    })
  }

  async get(owner: string, id: string): Promise<SendTask> {
    await this.writes.catch(() => undefined)
    return structuredClone(this.owned(await this.storage.read(), owner, id))
  }

  async pending(owner: string, accountId: string, conversationId: string, targetKey?: string): Promise<SendTask | null> {
    await this.writes.catch(() => undefined)
    const data = await this.storage.read()
    return structuredClone([...data.tasks].reverse().find(task => task.owner === owner
      && task.accountId === accountId && task.conversationId === conversationId && sameTarget(task, targetKey) && !['sent', 'cancelled'].includes(task.state)) || null)
  }

  private update(owner: string, id: string, patch: Partial<SendTask>): Promise<SendTask> {
    return this.transaction(data => Object.assign(this.owned(data, owner, id), patch, { updatedAt: Date.now() }))
  }

  useTranslationRequest(owner: string, id: string, request: TranslationRequest): Promise<SendTask> {
    return this.transaction(data => {
      const task = this.owned(data, owner, id)
      if (!['draft','translating'].includes(task.state) || task.translated !== undefined || !request.requestId?.startsWith('send-')
        || request.text !== task.request.text || request.accountId !== task.accountId
        || request.conversationId !== task.conversationId || request.targetLanguage !== task.request.targetLanguage) throw new Error('此发送任务不能替换翻译请求。')
      task.request = structuredClone(request); task.updatedAt = Date.now()
      return task
    })
  }
  translate(owner: string, id: string, run: (request: TranslationRequest) => Promise<string>, authorized: () => boolean): Promise<SendTask> {
    const key = `${owner}:${id}`
    const existing = this.translations.get(key)
    if (existing) return existing
    const work = (async () => {
      const task = await this.get(owner, id)
      if (!authorized()) throw new Error('登录状态已变化，请重新打开原发送任务。')
      if (task.state === 'cancelled') throw new Error('此任务已取消，请按当前设置重新发送。')
      if (task.state === 'sent') return task
      if (task.translated !== undefined) return task
      if (['uncertain','submitting'].includes(task.state)) throw new Error(uncertainSendMessage)
      await this.update(owner, id, { state: 'translating' })
      try {
        const translated = task.translate && !alreadyInTargetLanguage(task.request) ? await run(task.request) : task.request.text
        if (!translated.trim() && !hasSignalMedia(task.signalPayload)) throw new Error('翻译结果为空，草稿已保留。')
        const ready = await this.update(owner, id, { translated, state: 'ready' })
        if (!authorized()) throw new Error('登录状态已变化，译文已保存但未发送。')
        return ready
      } catch (error) {
        const latest = await this.get(owner, id)
        if (latest.translated === undefined) await this.update(owner, id, { state: 'draft' })
        throw error
      }
    })().finally(() => { this.translations.delete(key) })
    this.translations.set(key, work)
    return work
  }

  submit(owner: string, id: string, run: (task: SendTask) => Promise<unknown>, authorized: () => boolean): Promise<SendTask> {
    const key = `${owner}:${id}`
    const existing = this.submissions.get(key)
    if (existing) return existing
    const work = (async () => {
      const task = await this.get(owner, id)
      if (!authorized()) throw new SendNotStartedError('登录状态已变化，已阻止发送。')
      if (task.state === 'sent') return task
      if (task.state === 'cancelled') throw new SendNotStartedError('此任务已取消。')
      if (task.state === 'uncertain' || task.state === 'submitting') throw new Error(uncertainSendMessage)
      if (task.translated === undefined) throw new SendNotStartedError('译文尚未确认，草稿已保留。')
      if (hasBlockedChinese(task.translated, task.request.targetLanguage)) {
        throw new SendNotStartedError('结果仍包含中文，已阻止发送并保留草稿。')
      }
      if (task.translate && task.translated.trim()) {
        try { validateTranslation(task.request, task.translated) }
        catch (error) { throw new SendNotStartedError((error as Error).message) }
      }
      // A crash after this write is treated as uncertain; never auto-resend.
      await this.update(owner, id, { state: 'submitting' })
      try {
        if (!authorized()) throw new SendNotStartedError('登录状态已变化，已阻止发送。')
        const result = await run(task)
        return await this.update(owner, id, { state: 'sent', result })
      } catch (error) {
        const updated = await this.transaction(data => {
          const current = this.owned(data, owner, id)
          // A late receipt can arrive while the failed dispatch is being saved.
          // Keep confirmed evidence and the state transition in one transaction.
          if (current.state === 'sent') return current
          return Object.assign(current, { state: error instanceof SendNotStartedError ? 'ready' : 'uncertain', updatedAt: Date.now(),
            ...(error instanceof SendPendingError ? { result: error.evidence } : {}) })
        })
        if (updated.state === 'sent') return updated
        if (error instanceof SendPendingError) return updated
        throw error instanceof SendNotStartedError ? error : new Error(uncertainSendMessage)
      }
    })().finally(() => { this.submissions.delete(key) })
    this.submissions.set(key, work)
    return work
  }

  async originalForMessage(owner: string, accountId: string, messageId: string, text: string): Promise<string | undefined> {
    await this.writes.catch(() => undefined)
    const data = await this.storage.read()
    const saved = data.originals?.[originalKey(owner, accountId, messageId)]
    if (saved?.owner === owner && saved.accountId === accountId && saved.messageId === messageId && saved.text === displayText(text)) return saved.original
    // Also restore beta6 records before their next journal write.
    const matches = data.tasks.filter(task => task.owner === owner && task.accountId === accountId && task.platform === 'whatsapp' && task.state === 'sent'
      && (task.result as any)?.messageId === messageId && task.translated !== undefined && displayText(task.translated) === displayText(text))
    return matches.length === 1 ? matches[0].request.text : undefined
  }

  resolveWithEvidence(owner: string, id: string, result: unknown): Promise<SendTask> {
    return this.transaction(data => {
      const task = this.owned(data, owner, id)
      if (task.platform === 'whatsapp') {
        const messageId = (result as any)?.messageId
        const normalize = (text?: string) => (text || '').replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim()
        // A DOM receipt proves the task only while its text/ID is unambiguous.
        // A later, different original may translate to the same visible text.
        const ambiguous = data.tasks.some(other => other.id !== id && other.owner === owner && other.accountId === task.accountId
          && other.platform === 'whatsapp' && other.conversationId === task.conversationId && other.state !== 'cancelled'
          && ((messageId && (other.result as any)?.messageId === messageId)
            || (other.createdAt >= task.createdAt && other.translated !== undefined && normalize(other.translated) === normalize(task.translated))))
        if (ambiguous) return task
      }
      if (['submitting', 'uncertain'].includes(task.state)) Object.assign(task, { state: 'sent', result, updatedAt: Date.now() })
      return task
    })
  }
  expireMessage(owner: string, id: string): Promise<void> {
    return this.transaction(data => {
      const task = data.tasks.find(item => item.owner === owner && item.id === id)
      if (!task || task.state !== 'sent') return
      task.request.text = ''; task.request.context = []; task.translated = undefined
      task.result = { expired: true }
      for (const item of data.tasks) if (item.owner === owner && item.accountId === task.accountId && item.conversationId === task.conversationId && ['sent','cancelled'].includes(item.state)) item.request.context = []
    })
  }
  expireContent(owner: string, accountId: string, conversationId: string, identity: string): Promise<void> {
    return this.transaction(data => {
      const messageIds = new Set([identity])
      for (const task of data.tasks) if (task.owner === owner && task.accountId === accountId) {
        if (task.conversationId === conversationId) task.request.context = []
        if (['sent','cancelled'].includes(task.state) && [task.id, task.request.requestId, task.request.messageId, (task.result as any)?.messageId].includes(identity)) {
          if ((task.result as any)?.messageId) messageIds.add((task.result as any).messageId)
          task.request.text = ''; task.request.context = []; task.translated = undefined; task.signalPayload = undefined; task.result = { expired: true }
        }
      }
      for (const [key, item] of Object.entries(data.originals || {})) if (item.owner === owner && item.accountId === accountId && messageIds.has(item.messageId)) delete data.originals![key]
    })
  }
  async expireOlderContent(owner: string, cutoff: number): Promise<void> {
    await this.writes.catch(() => undefined)
    const eligible = (task: SendTask) => task.owner === owner && ['sent','cancelled'].includes(task.state) && task.updatedAt < cutoff && !(task.result as any)?.expired
    const snapshot = await this.storage.read()
    if (!snapshot.tasks.some(eligible) && !Object.values(snapshot.originals || {}).some(item => item.owner === owner && item.at < cutoff)) return
    await this.transaction(data => {
      for (const task of data.tasks) if (eligible(task)) {
        task.request.text = ''; task.request.context = []; task.translated = undefined; task.signalPayload = undefined; task.result = { expired: true }
      }
      // Original display aliases can outlive their pruned completed task. Their
      // own timestamp ensures older installations are covered as well.
      for (const [key, item] of Object.entries(data.originals || {})) if (item.owner === owner && item.at < cutoff) delete data.originals![key]
    })
  }

  confirmNotSent(owner: string, id: string): Promise<SendTask> {
    if (this.submissions.has(`${owner}:${id}`)) return Promise.reject(new Error('发送仍在处理中，请稍后核对。'))
    return this.transaction(data => {
      const task = this.owned(data, owner, id)
      if (!['uncertain', 'submitting'].includes(task.state)) throw new Error('此任务无需重新确认发送。')
      task.state = task.translated !== undefined ? 'ready' : 'draft'
      task.updatedAt = Date.now()
      return task
    })
  }

  cancel(owner: string, id: string): Promise<SendTask> {
    const key = `${owner}:${id}`
    if (this.submissions.has(key) || this.translations.has(key)) return Promise.reject(new Error('任务仍在处理中，请稍后取消。'))
    return this.transaction(data => {
      const task = this.owned(data, owner, id)
      if (!['draft', 'translating', 'ready'].includes(task.state)) throw new Error('请先核对发送结果，不能取消状态未确认的任务。')
      task.state = 'cancelled'
      task.updatedAt = Date.now()
      return task
    })
  }

  confirmSent(owner: string, id: string): Promise<SendTask> {
    if (this.submissions.has(`${owner}:${id}`)) return Promise.reject(new Error('发送仍在处理中，请稍后核对。'))
    return this.transaction(data => {
      const task = this.owned(data, owner, id)
      if (!['uncertain', 'submitting'].includes(task.state)) throw new Error('此任务无需重新确认发送。')
      task.state = 'sent'
      task.result = { confirmedByUser: true }
      task.updatedAt = Date.now()
      return task
    })
  }
}
