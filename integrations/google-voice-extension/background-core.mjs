import { ADAPTER, digest, isVoiceUrl, validToken, translationPayload, statusValue, translatedValue, validId, textValue } from './protocol.mjs'

/** Pairing credentials never leave this trusted extension context. */
export class ExtensionBridge {
  constructor({ native, storage, runtime }) { this.native = native; this.storage = storage; this.runtime = runtime; this.draftTail = Promise.resolve() }
  draftTransaction(work) {
    const next = this.draftTail.then(async () => {
      const raw = (await this.storage.get('outgoingDraftIds')).outgoingDraftIds
      const records = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const result = await work(records)
      await this.storage.set({ outgoingDraftIds: records }); return result
    })
    this.draftTail = next.catch(() => {}); return next
  }
  async token() { const value = (await this.storage.get('pairToken')).pairToken; return validToken(value) ? value : undefined }
  popupSender(sender) { return sender?.id === this.runtime.id && !sender.tab && sender.url === this.runtime.getURL('popup.html') }
  contentSender(sender) { return sender?.id === this.runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0 && isVoiceUrl(sender.url) }
  async handle(message, sender) {
    if (!message || message.v !== 1) throw new Error('请求无效。')
    if (message.type === 'adapter.status' && this.contentSender(sender)) return { adapter: ADAPTER }
    if (typeof message.type === 'string' && message.type.startsWith('voice.') && this.contentSender(sender)) return this.voice(message, sender)
    if (!this.popupSender(sender)) throw new Error('此操作仅允许在扩展面板执行。')
    if (message.type === 'pair') {
      const code = typeof message.code === 'string' ? message.code.trim() : ''
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) throw new Error('请粘贴 HelloDog 提供的完整连接码。')
      const result = await this.native.request('pair', { code })
      if (!validToken(result.pairToken)) throw new Error('客户端连接回执无效。')
      await this.storage.set({ pairToken: result.pairToken })
      return { paired: true, adapter: ADAPTER }
    }
    if (message.type === 'disconnect') { await this.storage.remove('pairToken'); return { paired: false, adapter: ADAPTER } }
    if (message.type === 'status') {
      const token = await this.token()
      if (!token) return { paired: false, adapter: ADAPTER }
      return { paired: true, status: statusValue(await this.native.request('status', undefined, token)), adapter: ADAPTER }
    }
    // A web page cannot manufacture a verified composer adapter or authorize send.
    throw new Error('页面适配尚未验证，未启用发送保护。')
  }
  async voice(message, sender) {
    const token = await this.token()
    if (!token) throw new Error('请先在扩展中连接 HelloDog。')
    if (message.type === 'voice.status') return statusValue(await this.native.request('status', undefined, token))
    const url = new URL(sender.url), item = url.searchParams.get('itemId')
    if (!/^\/u\/\d+\/messages\/?$/.test(url.pathname) || !item?.startsWith('t.') || item.length <= 2 || item.length > 1024) throw new Error('尚未确认短信会话，已阻止操作。')
    const conversationId = 'gv_' + await digest(JSON.stringify([url.pathname.replace(/\/$/, ''), item]))
    const value = message.payload
    if (!value || value.conversationId !== conversationId) throw new Error('会话已变化，已阻止操作。')
    if (message.type === 'voice.outgoing-id') {
      const key = await digest(JSON.stringify([token, conversationId, textValue(value.text)]))
      return this.draftTransaction(async records => {
        if (await this.token() !== token) throw new Error('连接已变化。')
        if (!records[key]) {
          if (Object.keys(records).length >= 10000) throw new Error('待核对草稿较多，请先核对已有发送记录。')
          records[key] = { id: crypto.randomUUID() }
        }
        if (!validId(records[key].id)) throw new Error('草稿记录无效，请在 HelloDog 核对。')
        return { id: records[key].id }
      })
    }
    let op, payload
    if (message.type === 'voice.translate') { op = 'translate'; payload = translationPayload(value) }
    else if (message.type === 'voice.authorize') {
      if (!validId(value.id) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value.requestId)) throw new Error('发送回执无效。')
      op = 'authorize'; payload = { id: value.id, conversationId, text: textValue(value.text), translated: textValue(value.translated), requestId: value.requestId }
    } else if (message.type === 'voice.dispatch-status') { op = 'dispatch-status'; payload = { conversationId, text: textValue(value.text) } }
    else if (message.type === 'voice.dispatch-resolve') {
      if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value.requestId) || !['sent', 'not-sent'].includes(value.outcome) || value.confirmed !== true || !Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new Error('请先明确核对发送结果。')
      op = 'dispatch-resolve'; payload = { conversationId, requestId: value.requestId, attempt: value.attempt, outcome: value.outcome, confirmed: true }
    } else throw new Error('操作尚未支持。')
    if (await this.token() !== token) throw new Error('连接已变化，请重试。')
    if (op === 'authorize' || op === 'translate' && payload.direction === 'outgoing') {
      const key = await digest(JSON.stringify([token, conversationId, payload.text]))
      await this.draftTransaction(records => {
        if (!records[key] || records[key].id !== payload.id) throw new Error('草稿编号不匹配，已阻止发送。')
        if (op === 'authorize') records[key].requestId = payload.requestId
      })
    }
    if (await this.token() !== token) throw new Error('连接已变化，请重试。')
    const result = await this.native.request(op, payload, token)
    if (await this.token() !== token) throw new Error('连接已变化，未显示旧连接结果。')
    if (op === 'translate') return translatedValue(result)
    if (op === 'authorize') {
      if (result?.authorized !== true || result.requestId !== payload.requestId || !Number.isSafeInteger(result.attempt) || result.attempt < 1) throw new Error('发送授权尚未确认。')
      return { authorized: true, requestId: result.requestId, attempt: result.attempt }
    }
    if (op === 'dispatch-resolve') {
      if (result?.resolved !== true) throw new Error('发送结果尚未核对。')
      if (payload.outcome === 'sent') await this.draftTransaction(records => { for (const [key, record] of Object.entries(records)) if (record.requestId === payload.requestId) delete records[key] })
      return { resolved: true }
    }
    if (!['clear', 'uncertain'].includes(result?.state)) throw new Error('发送状态无效。')
    if (result.state === 'clear') return { state: 'clear' }
    if (typeof result.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(result.requestId) || !Number.isSafeInteger(result.attempt) || result.attempt < 1) throw new Error('待核对记录无效。')
    return { state: 'uncertain', requestId: result.requestId, attempt: result.attempt }
  }
  async translateSelection(text, tabUrl, messageId, capturedToken) {
    if (!isVoiceUrl(tabUrl)) throw new Error('只支持在 Google Voice 官方网页中翻译选中文字。')
    const payload = translationPayload({ direction: 'incoming', id: messageId, conversationId: 'manual-selection', text, manual: true })
    const token = await this.token()
    if (!token) throw new Error('请先在扩展中连接 HelloDog。')
    if (capturedToken !== undefined && token !== capturedToken) throw new Error('连接已变化，请重新选择文字。')
    const result = translatedValue(await this.native.request('translate', payload, token))
    if (await this.token() !== token) throw new Error('连接已变化，未显示旧连接的翻译结果。')
    return result
  }
  async selectionScope() {
    const token = await this.token()
    if (!token) throw new Error('请先在扩展中连接 HelloDog。')
    const status = statusValue(await this.native.request('status', undefined, token))
    if (!status.connected || typeof status.localLanguage !== 'string') throw new Error('HelloDog 暂未就绪。')
    if (await this.token() !== token) throw new Error('连接已变化，请重新选择文字。')
    return {
      key: await digest(JSON.stringify([token, status.localLanguage])),
      current: async () => await this.token() === token,
      translate: (text, tabUrl, messageId) => this.translateSelection(text, tabUrl, messageId, token)
    }
  }
}

/** Only hashes, logical IDs and result previews; never persist selected text. */
export class SelectionTasks {
  constructor() { this.tabs = new Map() }
  clear(tabId) { if (tabId === undefined) this.tabs.clear(); else this.tabs.delete(tabId) }
  run({ tabId, ticket, key, id }, translate) {
    if (!Number.isInteger(tabId) || !validId(ticket) || !/^[a-f0-9]{64}$/.test(key) || !validId(id)) return Promise.reject(new Error('页面翻译记录无效。'))
    let page = this.tabs.get(tabId)
    if (!page && this.tabs.size >= 32) return Promise.reject(new Error('打开的翻译页面较多，请先关闭不再使用的页面。'))
    if (!page || page.ticket !== ticket) { page = { ticket, items: new Map() }; this.tabs.set(tabId, page) }
    let item = page.items.get(key)
    if (!item) {
      if (page.items.size >= 128) return Promise.reject(new Error('当前页面翻译任务较多，请先完成现有任务。'))
      item = { id }; page.items.set(key, item)
    }
    if (item.id !== id) return Promise.reject(new Error('翻译编号不一致，请保留当前页面。'))
    if (item.result) return Promise.resolve(item.result)
    if (item.work) return item.work
    const work = Promise.resolve().then(() => translate(item.id)).then(result => { item.result = result; return result })
    item.work = work
    void work.then(() => { item.work = undefined }, () => { item.work = undefined })
    return work
  }
}
