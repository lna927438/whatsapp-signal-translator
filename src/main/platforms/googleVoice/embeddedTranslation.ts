import { createHash, randomUUID } from 'crypto'
import { GoogleVoiceDraftRecoveryError } from './draftRecovery'
import { GoogleVoiceDispatchScopeError } from './dispatchLedger'
import { googleVoiceMessageMedia, googleVoiceMediaKey, googleVoiceRecipientContext, type GoogleVoiceMessageMedia } from './messageMedia'
import { GoogleVoiceIncomingHistory } from './incomingHistory'

export interface GoogleVoiceEmbeddedTrustedPage {
  owner: string
  accountId: string
  url: string
  authorized: () => boolean
}
type Draft = { id: string; scopeHash: string; requestId?: string; recoveryRequestId?: string }
export type GoogleVoiceEmbeddedDraftData = { records: Record<string, Draft> }
type Storage = { read(): Promise<GoogleVoiceEmbeddedDraftData>; write(data: GoogleVoiceEmbeddedDraftData): Promise<void> }
type Operation = 'status' | 'translate' | 'authorize' | 'dispatch-status' | 'dispatch-resolve'
type TranslationHandler = (owner: string, accountId: string, operation: string, payload: unknown, authorized: () => boolean) => Promise<unknown>
type Reply = { ok: true; result: unknown } | { ok: false; error: string; code: string }
export interface GoogleVoiceEmbeddedTranslationOptions<Event = unknown> {
  trustedPage: (event: Event) => GoogleVoiceEmbeddedTrustedPage
  translate: TranslationHandler
  storage: Storage
  timeoutMs?: number
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const supported = new Set(['voice.status', 'voice.history-baseline', 'voice.outgoing-id', 'voice.translate', 'voice.authorize', 'voice.dispatch-status', 'voice.dispatch-resolve'])
// These exact application messages are safe to classify. Never echo arbitrary
// provider/server text: it can contain source material, credentials or paths.
const loginFailures = new Set([
  '请先登录在线账号。', '登录状态已失效，请重新登录。', '登录已失效，请重新登录。',
  '在线登录令牌缺失，请重新登录。', '在线登录状态已过期，请重新登录。',
  '在线登录状态已过期，请重新登录后核对原请求。', '登录状态已变化，消息未发送。',
  '登录状态已变化，请重新登录。草稿已保留。', '登录会话已失效，请重新登录。草稿与翻译记录已保留。',
  '暂时无法恢复在线登录，请检查网络或重新登录。草稿已保留。', '在线登录尚未恢复，请重新登录。草稿已保留。'
])
const balanceFailures = new Set([
  '可用字符已用完，无法发送翻译消息。请补充字符后重试，草稿已保留。',
  '可用字符余额不足。原请求已保留，结算以查询结果为准。'
])
const accountFailures = new Set(['账号状态不可用，消息未发送。', '账号已停用，请联系管理员。', '账号已停用，无法使用在线翻译。原请求仍需核对。', '当前账号没有访问权限。'])

class BridgeFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const invalid = () => new BridgeFailure('invalid', '请求无效，原文未自动发送。')
function requireCurrent(page: GoogleVoiceEmbeddedTrustedPage): void {
  let current = false
  try { current = page.authorized() } catch { /* Trusted ownership lookup can disappear during shutdown. */ }
  if (!current) throw new BridgeFailure('changed', '登录或页面已变化，请重新核对当前短信。原文未自动发送。')
}
function text(value: unknown, media?: GoogleVoiceMessageMedia): string {
  if (typeof value !== 'string' || !value.trim() && !media || value.includes('\0') || Array.from(value).length > 8000) throw invalid()
  return value
}
function translatedText(value: unknown, media?: GoogleVoiceMessageMedia): string {
  // Translation can expand beyond the source limit. Match the translator's
  // output/authorization boundary so a paid receipt remains usable in preview.
  if (typeof value !== 'string' || !value.trim() && !media || value.includes('\0') || value.length > 20000) throw invalid()
  return value
}
function statusValue(value: unknown): Record<string, unknown> {
  if (!object(value) || typeof value.connected !== 'boolean') throw invalid()
  const result: Record<string, unknown> = { connected: value.connected }
  for (const key of ['localLanguage', 'targetLanguage', 'historyMode']) if (typeof value[key] === 'string' && value[key].length <= 64) result[key] = value[key]
  for (const key of ['receiveAutoTranslate', 'sendAutoTranslate', 'blockChineseSend', 'translationsVisible']) if (typeof value[key] === 'boolean') result[key] = value[key]
  if (Number.isSafeInteger(value.sendPolicyRevision) && (value.sendPolicyRevision as number) >= 0) result.sendPolicyRevision = value.sendPolicyRevision
  return result
}
function translatedValue(value: unknown, media?: GoogleVoiceMessageMedia): Record<string, unknown> {
  if (!object(value) || typeof value.enabled !== 'boolean') throw invalid()
  if (!value.enabled) throw new BridgeFailure('disabled', '当前账号未启用该方向翻译。')
  if (!requestId(value.requestId)) throw invalid()
  if (media) {
    const received = googleVoiceMessageMedia(value.media)
    if (!received || googleVoiceMediaKey(received) !== googleVoiceMediaKey(media)) throw invalid()
  } else if (value.media !== undefined) throw invalid()
  return { enabled: true, text: translatedText(value.text, media), requestId: value.requestId, ...(value.untranslated === true ? { untranslated: true } : {}), ...(media ? { media } : {}) }
}

/** Main-only replacement for the extension's transport and draft-ID storage.
 * The caller resolves identity from the registered WebContents, never from a
 * payload. Existing TranslationEngine/credit and dispatch journal remain sole
 * owners of billing and send reservations. No browser credential is involved.
 */
export class GoogleVoiceEmbeddedTranslation<Event = unknown> {
  private writes: Promise<unknown> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly incomingHistory = new GoogleVoiceIncomingHistory()
  private readonly timeoutMs: number
  constructor(private readonly options: GoogleVoiceEmbeddedTranslationOptions<Event>) {
    this.timeoutMs = options.timeoutMs ?? 70000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) throw new Error('Invalid Google Voice operation timeout')
  }

  async request(event: Event, input: unknown): Promise<Reply> {
    let page: GoogleVoiceEmbeddedTrustedPage
    let message: Record<string, unknown>
    try {
      page = this.options.trustedPage(event)
      requireCurrent(page)
      if (typeof page.owner !== 'string' || !page.owner || page.owner.length > 512 || typeof page.accountId !== 'string' || !/^gv-[a-f0-9-]{36}$/.test(page.accountId)) throw invalid()
      const url = new URL(page.url)
      if (url.origin !== 'https://voice.google.com' || url.username || url.password || url.port) throw invalid()
      if (!object(input) || input.v !== 1 || typeof input.type !== 'string' || !supported.has(input.type) || Buffer.byteLength(JSON.stringify(input), 'utf8') > 131072) throw invalid()
      message = input
    } catch (error) { return this.failure(error) }

    const scopeHash = hash([page.owner, page.accountId])
    if (this.inFlight.has(scopeHash)) return { ok: false, code: 'busy', error: '上一项请求仍在处理，当前操作未提交。请稍后重试。' }
    let timedOut = false
    const beforeUpstream = () => {
      requireCurrent(page)
      if (timedOut) throw new BridgeFailure('timeout', '请求已超时，未启动新的翻译；请保留草稿并手动重试。')
    }
    // The slot survives a lost UI receipt, navigation and UI timeout. Release it
    // only when actual work finishes; never leave delayed billable work queued.
    const operation = Promise.resolve().then(() => this.execute(page, scopeHash, message, beforeUpstream))
    this.inFlight.set(scopeHash, operation)
    const release = () => { if (this.inFlight.get(scopeHash) === operation) this.inFlight.delete(scopeHash) }
    void operation.then(release, release)
    return new Promise<Reply>(resolve => {
      let replied = false
      const finish = (reply: Reply) => { if (replied) return; replied = true; clearTimeout(timer); resolve(reply) }
      const timer = setTimeout(() => { timedOut = true; finish({ ok: false, code: 'timeout', error: '请求超时、结果尚未确认；任务已保留，不会自动重试或发送消息。' }) }, this.timeoutMs)
      void operation.then(result => {
        try { requireCurrent(page); finish({ ok: true, result }) } catch (error) { finish(this.failure(error)) }
      }, error => finish(this.failure(error)))
    })
  }

  private failure(error: unknown): Reply {
    if (error instanceof BridgeFailure) return { ok: false, code: error.code, error: error.message }
    if (error instanceof GoogleVoiceDraftRecoveryError) return { ok: false, code: 'draft-recovery', error: error.message }
    if (error instanceof GoogleVoiceDispatchScopeError) return { ok: false, code: 'dispatch-scope', error: error.message }
    const message = object(error) && typeof error.message === 'string' ? error.message : ''
    if (loginFailures.has(message)) return { ok: false, code: 'login', error: 'HelloDog 登录需要恢复，请在个人中心重新登录。草稿和原翻译记录已保留。' }
    if (balanceFailures.has(message)) return { ok: false, code: 'balance', error: '可用字符不足，请补充字符后重试。草稿已保留；原请求的扣费结果仍以记录核对为准。' }
    if (accountFailures.has(message)) return { ok: false, code: 'account', error: '当前 HelloDog 账号不可用，请联系管理员核对账号状态。草稿和原翻译记录已保留。' }
    if (message === '请开启发送翻译，中文原文已阻止发送。') return { ok: false, code: 'disabled', error: '请在翻译语言与偏好中开启发送翻译，中文原文已阻止发送。' }
    // Do not echo provider failures, source text, paths or account credentials.
    return { ok: false, code: 'unavailable', error: '翻译或连接暂未完成，请检查 HelloDog 的登录、网络和字符余额后重试。原文未自动发送。' }
  }

  private async drafts<T>(page: GoogleVoiceEmbeddedTrustedPage, change: (records: Record<string, Draft>) => T | Promise<T>): Promise<T> {
    const work = this.writes.catch(() => undefined).then(async () => {
      requireCurrent(page)
      const stored = await this.options.storage.read()
      requireCurrent(page)
      if (!object(stored) || !object(stored.records) || Object.keys(stored.records).length > 10000) throw invalid()
      // Validate rather than discard corrupted IDs: silently resetting these
      // records would make the next retry look like a new billable translation.
      const records: Record<string, Draft> = Object.create(null)
      for (const [key, row] of Object.entries(stored.records)) {
        if (!digest(key) || !object(row) || !uuid(row.id) || !digest(row.scopeHash) || row.requestId !== undefined && !requestId(row.requestId) || row.recoveryRequestId !== undefined && (typeof row.recoveryRequestId !== 'string' || !/^send-(?:gv|retry)-[a-f0-9]{64}$/.test(row.recoveryRequestId))) throw invalid()
        records[key] = { id: row.id, scopeHash: row.scopeHash, ...(row.requestId ? { requestId: row.requestId as string } : {}), ...(row.recoveryRequestId ? { recoveryRequestId: row.recoveryRequestId as string } : {}) }
      }
      const result = await change(records)
      requireCurrent(page)
      await this.options.storage.write({ records })
      requireCurrent(page)
      return result
    })
    this.writes = work
    return work
  }

  private async execute(page: GoogleVoiceEmbeddedTrustedPage, scopeHash: string, message: Record<string, unknown>, beforeUpstream: () => void): Promise<unknown> {
    requireCurrent(page)
    if (message.type === 'voice.status') {
      beforeUpstream()
      const result = await this.options.translate(page.owner, page.accountId, 'status', undefined, page.authorized)
      requireCurrent(page); return { ...statusValue(result), newMessageTracking: true }
    }
    const value = message.payload
    if (!object(value)) throw invalid()
    const url = new URL(page.url), item = url.searchParams.get('itemId')
    let context
    try { context = googleVoiceRecipientContext(value.context) } catch { throw invalid() }
    if (!/^\/u\/\d+\/messages\/?$/.test(url.pathname) ||
      (item === 'draft' ? !context : !!context || !item?.startsWith('t.') || item.length <= 2 || item.length > 1024)) throw new BridgeFailure('unsupported', '尚未确认短信收件人，已阻止操作。')
    const path = url.pathname.replace(/\/$/, '')
    const conversationId = 'gv_' + hash(context ? [path, 'draft', context.recipientKey, context.recipientCount] : [path, item])
    if (value.conversationId !== conversationId) throw new BridgeFailure('changed', '会话已变化，已阻止操作。')
    if (message.type === 'voice.history-baseline') {
      if (context) throw invalid()
      try { return this.incomingHistory.begin(scopeHash, conversationId, value.ids, page) } catch { throw invalid() }
    }
    let media: GoogleVoiceMessageMedia | undefined
    try { media = googleVoiceMessageMedia(value.media) } catch { throw invalid() }
    if ((media || context) && value.direction === 'incoming') throw invalid()
    const mediaPayload = { ...(media ? { media } : {}), ...(context ? { context } : {}) }
    const draftKey = (source: string) => hash([page.owner, page.accountId, conversationId, source, ...(media ? [googleVoiceMediaKey(media)] : [])])
    if (message.type === 'voice.outgoing-id') {
      const source = text(value.text, media), key = draftKey(source)
      return this.drafts(page, async records => {
        if (!records[key]) {
          if (Object.keys(records).length >= 10000) throw new BridgeFailure('capacity', '待核对草稿较多，请先核对已有发送记录。')
          beforeUpstream()
          const recovered = await this.options.translate(page.owner, page.accountId, 'recover-draft', { conversationId, text: source, ...mediaPayload }, page.authorized)
          beforeUpstream()
          if (!object(recovered) || !['new', 'recovered'].includes(String(recovered.state))) throw invalid()
          if (recovered.state === 'recovered') {
            if (!uuid(recovered.id) || typeof recovered.requestId !== 'string' || !/^send-(?:gv|retry)-[a-f0-9]{64}$/.test(recovered.requestId)) throw invalid()
            records[key] = { id: recovered.id, scopeHash, recoveryRequestId: recovered.requestId }
          } else records[key] = { id: randomUUID(), scopeHash }
        }
        if (records[key].scopeHash !== scopeHash) throw invalid()
        return { id: records[key].id }
      })
    }
    let operation: Operation, payload: Record<string, unknown>
    if (message.type === 'voice.translate') {
      if (!uuid(value.id) || !['incoming', 'outgoing'].includes(String(value.direction)) || value.manual !== undefined && typeof value.manual !== 'boolean') throw invalid()
      operation = 'translate'
      payload = { id: value.id, direction: value.direction, conversationId, text: text(value.text, media), ...mediaPayload, ...(value.manual === undefined ? {} : { manual: value.manual }) }
      if (payload.direction === 'incoming' && payload.manual !== true) this.incomingHistory.attest(scopeHash, payload, value.newMessage, page)
    } else if (message.type === 'voice.authorize') {
      if (!uuid(value.id) || !requestId(value.requestId)) throw invalid()
      operation = 'authorize'; payload = { id: value.id, conversationId, text: text(value.text, media), translated: translatedText(value.translated, media), requestId: value.requestId, ...mediaPayload }
    } else if (message.type === 'voice.dispatch-status') {
      // A lost send reply can leave the expanded translation in the editor.
      // Looking up its fingerprint must not reapply the smaller source limit.
      operation = 'dispatch-status'; payload = { conversationId, text: translatedText(value.text, media), ...mediaPayload }
    } else if (message.type === 'voice.dispatch-resolve') {
      if (!requestId(value.requestId) || !['sent', 'not-sent'].includes(String(value.outcome)) || value.confirmed !== true || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) throw invalid()
      operation = 'dispatch-resolve'; payload = { conversationId, requestId: value.requestId, attempt: value.attempt, outcome: value.outcome, confirmed: true, ...mediaPayload }
    } else throw invalid()

    if (operation === 'authorize' || operation === 'translate' && payload.direction === 'outgoing') {
      const key = draftKey(payload.text as string)
      await this.drafts(page, records => {
        const row = records[key]
        if (!row || row.id !== payload.id || row.scopeHash !== scopeHash) throw new BridgeFailure('draft', '草稿编号不匹配，已阻止发送。')
        if (operation === 'authorize') row.requestId = payload.requestId as string
        if (row.recoveryRequestId) payload.recoveryRequestId = row.recoveryRequestId
      })
    }
    // Local persistence can wait behind another window. Do not start billable
    // work after that wait has already exhausted this UI operation's deadline.
    beforeUpstream()
    const result = await this.options.translate(page.owner, page.accountId, operation, payload, page.authorized)
    requireCurrent(page)
    if (operation === 'translate') {
      // Incoming cache misses in manual/hidden mode are ordinary no-result
      // responses. Keep them distinct from failed translation or send previews.
      if (payload.direction === 'incoming' && object(result) && result.enabled === false) return { enabled: false, manual: result.manual === true }
      return translatedValue(result, media)
    }
    if (operation === 'authorize') {
      if (!object(result) || result.authorized !== true || result.requestId !== payload.requestId || !Number.isSafeInteger(result.attempt) || Number(result.attempt) < 1) throw invalid()
      return { authorized: true, requestId: result.requestId, attempt: result.attempt }
    }
    if (operation === 'dispatch-resolve') {
      if (!object(result) || result.resolved !== true) throw invalid()
      if (payload.outcome === 'sent') await this.drafts(page, records => {
        const sentIds = new Set(Object.values(records).filter(row => row.scopeHash === scopeHash && row.requestId === payload.requestId).map(row => row.id))
        // Migration can recover several whitespace variants to one old UUID.
        // A confirmed send retires every alias of that logical draft.
        for (const [key, row] of Object.entries(records)) if (row.scopeHash === scopeHash && (row.requestId === payload.requestId || sentIds.has(row.id))) delete records[key]
      })
      return { resolved: true }
    }
    if (!object(result) || !['clear', 'uncertain'].includes(String(result.state))) throw invalid()
    if (result.state === 'clear') return { state: 'clear' }
    if (!requestId(result.requestId) || !Number.isSafeInteger(result.attempt) || Number(result.attempt) < 1) throw invalid()
    return { state: 'uncertain', requestId: result.requestId, attempt: result.attempt }
  }
}
