export const HOST = 'net.hellodog.google_voice'
export const MAX_TEXT = 8000
export const MAX_TRANSLATED_TEXT = 20000
export const ADAPTER = Object.freeze({ supported: false, reason: '配对不代表当前页面已识别。请查看短信编辑器上方的保护状态；未知页面仍可右键翻译选中文字。' })
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const opaque = /^[A-Za-z0-9_-]{32,256}$/
export function validToken(value) { return typeof value === 'string' && opaque.test(value) }
export function validId(value) { return typeof value === 'string' && uuid.test(value) }
export async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') }
export function isVoiceUrl(value) {
  try { const url = new URL(value); return url.origin === 'https://voice.google.com' && !url.username && !url.password } catch { return false }
}
export function selectedContext(info, tab) {
  // Chrome documents frameId/frameUrl as optional for top-level menu clicks.
  if (info?.menuItemId !== 'hellodog-translate-selection' || !Number.isInteger(tab?.id) || !isVoiceUrl(tab.url) ||
      info.frameId !== undefined && info.frameId !== 0 || info.frameId === undefined && info.frameUrl !== undefined ||
      info.pageUrl !== undefined && info.pageUrl !== tab.url) return null
  try { return { tabId: tab.id, url: tab.url, text: textValue(info.selectionText) } } catch { return null }
}
export function textValue(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > MAX_TEXT || /[\u0000]/u.test(value)) throw new Error('文字为空或过长。')
  return value
}
export function mediaValue(value) {
  if (value === undefined) return undefined
  if (!value || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 10
    || !Array.isArray(value.types) || value.types.length !== value.count || value.types.some(type => !['image/jpeg', 'image/png', 'image/gif', 'image/bmp'].includes(type))
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > 20 * 1024 * 1024) throw new Error('图片草稿无效或大小超出支持范围。')
  return { fingerprint: value.fingerprint, count: value.count, types: [...value.types], totalBytes: value.totalBytes }
}
export function recipientContextValue(value) {
  if (value === undefined) return undefined
  if (!value || value.kind !== 'recipients' || !/^[a-f0-9]{64}$/.test(value.recipientKey) || !Number.isSafeInteger(value.recipientCount) || value.recipientCount < 1 || value.recipientCount > 7) throw new Error('短信收件人尚未核实。')
  return { kind: 'recipients', recipientKey: value.recipientKey, recipientCount: value.recipientCount }
}
export function draftTextValue(value, media) {
  if (!media) return textValue(value)
  if (typeof value !== 'string' || Array.from(value).length > MAX_TEXT || /[\u0000]/u.test(value)) throw new Error('文字过长或格式无效。')
  return value
}
// Translation expansion has a separate bound from user-submitted source text.
// Keep this UTF-16 limit aligned with the main process translation receipt.
export function translatedTextValue(value, media) {
  if (typeof value !== 'string' || (!media && !value.trim()) || value.length > MAX_TRANSLATED_TEXT || /[\u0000]/u.test(value)) throw new Error('译文为空、过长或格式无效。')
  return value
}
export function translationPayload(value) {
  if (!value || !['incoming', 'outgoing'].includes(value.direction) || !validId(value.id) ||
      typeof value.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.conversationId) ||
      value.manual !== undefined && typeof value.manual !== 'boolean') throw new Error('翻译请求无效。')
  const media = mediaValue(value.media), context = recipientContextValue(value.context)
  if ((media || context) && value.direction !== 'outgoing') throw new Error('接收翻译不能提交发送附件或收件人。')
  return { direction: value.direction, id: value.id, conversationId: value.conversationId, text: draftTextValue(value.text, media), ...(media ? { media } : {}), ...(context ? { context } : {}), ...(value.manual === undefined ? {} : { manual: value.manual }) }
}
export function statusValue(value) {
  if (!value || typeof value.connected !== 'boolean') throw new Error('客户端状态无效。')
  const result = { connected: value.connected }
  for (const key of ['localLanguage', 'targetLanguage', 'historyMode']) if (typeof value[key] === 'string' && value[key].length <= 64) result[key] = value[key]
  for (const key of ['receiveAutoTranslate', 'sendAutoTranslate', 'blockChineseSend', 'translationsVisible']) if (typeof value[key] === 'boolean') result[key] = value[key]
  return result
}
export function translatedValue(value) {
  if (!value || typeof value.enabled !== 'boolean') throw new Error('翻译回执无效。')
  if (!value.enabled) throw new Error('当前账号未启用该方向翻译。')
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value.requestId)) throw new Error('翻译回执编号无效。')
  const media = mediaValue(value.media)
  return { enabled: true, text: translatedTextValue(value.text, media), requestId: value.requestId, ...(media ? { media } : {}), ...(value.untranslated === true ? { untranslated: true } : {}) }
}

export class NativeBusyError extends Error {
  constructor() { super('上一项请求仍在处理或等待核对，当前操作未提交。请稍后重试。'); this.name = 'NativeBusyError' }
}

/** Browser native messaging only. No HTTP fallback, implicit replay, or text logs. */
export class NativeClient {
  constructor(runtime, { timeoutMs = 70000, randomId = () => crypto.randomUUID() } = {}) {
    this.runtime = runtime; this.timeoutMs = timeoutMs; this.randomId = randomId
    this.port = null; this.pending = new Map()
  }
  connect() {
    if (this.port) return this.port
    const port = this.runtime.connectNative(HOST)
    this.port = port
    port.onMessage.addListener(message => {
      if (!message || message.v !== 1 || !validId(message.id)) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.ok === true && message.result && typeof message.result === 'object') pending.resolve(message.result)
      else pending.reject(new Error('客户端未完成请求，请查看 HelloDog。'))
    })
    port.onDisconnect.addListener(() => {
      // Read lastError to acknowledge it, but do not log paths/host payloads.
      void this.runtime.lastError
      if (this.port === port) this.port = null
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('HelloDog 连接已断开，请核对会话后再操作。')) }
      this.pending.clear()
    })
    return port
  }
  request(op, payload, pairToken) {
    if (!['pair', 'status', 'translate', 'authorize', 'dispatch-status', 'dispatch-resolve'].includes(op)) return Promise.reject(new Error('请求类型无效。'))
    if (op !== 'pair' && !validToken(pairToken)) return Promise.reject(new Error('请先在扩展中连接 HelloDog。'))
    // The official native relay handles requests serially. Never enqueue work
    // that could begin billing only after its UI has already timed out.
    if (this.pending.size !== 0) return Promise.reject(new NativeBusyError())
    const id = this.randomId(), message = { v: 1, id, op, ...(pairToken ? { pairToken } : {}), ...(payload ? { payload } : {}) }
    if (!validId(id) || new TextEncoder().encode(JSON.stringify(message)).length > 128 * 1024) return Promise.reject(new Error('请求格式无效。'))
    return new Promise((resolve, reject) => {
      // A UI timeout is not proof that the host stopped. Keep its slot occupied
      // until a late correlated receipt or disconnect arrives; do not replay.
      const timer = setTimeout(() => { reject(new Error('请求超时、尚未确认；任务已保留，不会自动重试或发送消息。')) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.connect().postMessage(message) }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('无法连接 HelloDog，请确认本机桥接已安装。')) }
    })
  }
}
