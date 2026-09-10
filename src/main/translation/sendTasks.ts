import { randomUUID } from 'crypto'
import type { TranslationRequest } from '../types'

export type SendState = 'draft' | 'translating' | 'ready' | 'submitting' | 'uncertain' | 'sent' | 'cancelled'
export interface SendTask {
  id: string
  owner: string
  platform: 'whatsapp' | 'signal'
  accountId: string
  conversationId: string
  targetKey?: string
  signalAccount?: string
  recipient?: string
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
export interface SendTaskData { tasks: SendTask[] }
export interface TaskPersistence { read(): Promise<SendTaskData>; write(data: SendTaskData): Promise<void> }

/** Only throw this when no platform send command has been dispatched. */
export class SendNotStartedError extends Error {}
const sameTarget = (task: SendTask, targetKey?: string) => task.targetKey === targetKey
  || (Boolean(targetKey?.startsWith('peer:')) && task.targetKey === 'title:' + task.conversationId)

export const uncertainSendMessage = '发送结果未确认。请先在原对话核对；确认未发送后才能重试。'

/** Persists the request snapshot before any API call or platform submission. */
export class SendTasks {
  private writes: Promise<unknown> = Promise.resolve()
  private translations = new Map<string, Promise<SendTask>>()
  private submissions = new Map<string, Promise<SendTask>>()
  constructor(private readonly storage: TaskPersistence) {}

  private transaction<T>(run: (data: SendTaskData) => T): Promise<T> {
    const next = this.writes.catch(() => {}).then(async () => {
      const data = await this.storage.read()
      const result = run(data)
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

  prepare(owner: string, input: NewSendTask): Promise<SendTask> {
    return this.transaction(data => {
      if (!owner || !input.accountId || !input.conversationId || !input.request.text.trim()) {
        throw new Error('无法确认发送账号、对话或草稿，已阻止发送。')
      }
      const text = input.request.text.trim()
      const unresolved = [...data.tasks].reverse().find(task => task.owner === owner
        && ['uncertain', 'submitting'].includes(task.state) && task.platform === input.platform
        && task.accountId === input.accountId && task.conversationId === input.conversationId
        && sameTarget(task, input.targetKey) && task.signalAccount === input.signalAccount)
      if (unresolved) return unresolved
      const previous = [...data.tasks].reverse().find(task => task.owner === owner && !['sent', 'cancelled'].includes(task.state)
        && task.platform === input.platform && task.accountId === input.accountId
        && task.conversationId === input.conversationId && task.signalAccount === input.signalAccount
        && sameTarget(task, input.targetKey) && task.recipient === input.recipient
        && task.request.text === text)
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

  get(owner: string, id: string): Promise<SendTask> {
    return this.transaction(data => this.owned(data, owner, id))
  }

  pending(owner: string, accountId: string, conversationId: string, targetKey?: string): Promise<SendTask | null> {
    return this.transaction(data => [...data.tasks].reverse().find(task => task.owner === owner
      && task.accountId === accountId && task.conversationId === conversationId && sameTarget(task, targetKey) && !['sent', 'cancelled'].includes(task.state)) || null)
  }

  private update(owner: string, id: string, patch: Partial<SendTask>): Promise<SendTask> {
    return this.transaction(data => Object.assign(this.owned(data, owner, id), patch, { updatedAt: Date.now() }))
  }

  translate(owner: string, id: string, run: (request: TranslationRequest) => Promise<string>, authorized: () => boolean): Promise<SendTask> {
    const key = `${owner}:${id}`
    const existing = this.translations.get(key)
    if (existing) return existing
    const work = (async () => {
      const task = await this.get(owner, id)
      if (!authorized()) throw new Error('登录状态已变化，请重新打开原发送任务。')
      if (task.state === 'cancelled') throw new Error('此任务已取消，请按当前设置重新发送。')
      if (task.translated !== undefined) return task
      await this.update(owner, id, { state: 'translating' })
      try {
        const translated = task.translate ? await run(task.request) : task.request.text
        if (!translated.trim()) throw new Error('翻译结果为空，草稿已保留。')
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
      if (task.blockChinese && /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(task.translated)) {
        throw new SendNotStartedError('结果仍包含中文，已阻止发送并保留草稿。')
      }
      // A crash after this write is treated as uncertain; never auto-resend.
      await this.update(owner, id, { state: 'submitting' })
      try {
        if (!authorized()) throw new SendNotStartedError('登录状态已变化，已阻止发送。')
        const result = await run(task)
        return await this.update(owner, id, { state: 'sent', result })
      } catch (error) {
        await this.update(owner, id, { state: error instanceof SendNotStartedError ? 'ready' : 'uncertain' })
        throw error instanceof SendNotStartedError ? error : new Error(uncertainSendMessage)
      }
    })().finally(() => { this.submissions.delete(key) })
    this.submissions.set(key, work)
    return work
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
