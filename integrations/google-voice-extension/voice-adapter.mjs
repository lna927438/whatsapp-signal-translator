import { digest } from './protocol.mjs'

const one = (root, selector) => { const found = [...root.querySelectorAll(selector)].filter(node => node.getClientRects().length > 0); return found.length === 1 ? found[0] : null }
const sourceText = node => node.textContent?.trim() || ''
const hashUuid = value => `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`

/** Selectors verified read-only against the official English SMS page.
 * Incoming/outgoing text verified read-only on 2026-09-18. New recipients and
 * attachment drafts remain unsupported.
 * All reads are rendered DOM; no private framework state, requests or cookies.
 */
export class GoogleVoiceDomAdapter {
  constructor(document, location) {
    this.document = document; this.location = location; this.current = null
    this.revisions = new WeakMap(); this.attachmentEntries = new WeakSet(); this.allowedButton = null
    this.onInput = event => {
      if (event.target?.matches?.('gv-message-entry textarea.message-input')) this.revisions.set(event.target, (this.revisions.get(event.target) || 0) + 1)
      if (event.target?.matches?.('gv-message-entry input[type="file"]')) this.attachmentEntries.add(event.target.closest('gv-message-entry'))
    }
    document.defaultView.addEventListener('input', this.onInput, true)
    document.defaultView.addEventListener('change', this.onInput, true)
  }
  route() {
    try {
      const url = new URL(this.location.href), item = url.searchParams.get('itemId')
      if (url.origin !== 'https://voice.google.com' || !/^\/u\/\d+\/messages\/?$/.test(url.pathname) || !item?.startsWith('t.') || item.length <= 2 || item.length > 1024) return null
      return JSON.stringify([url.pathname.replace(/\/$/, ''), item])
    } catch { return null }
  }
  inspect() {
    const route = this.route(), thread = one(this.document, 'gv-thread-details'), entry = one(this.document, 'gv-message-entry')
    if (!route || !thread || !entry || this.document.querySelector('gv-message-party-picker')) return null
    const composer = one(entry, 'textarea.message-input'), sendButton = one(entry, 'button.send-button[aria-label="Send message"]')
    if (!composer || !sendButton || composer.disabled || composer.readOnly || composer.getAttribute('aria-readonly') !== 'false' || composer.closest('form')) return null
    // Only the observed text composer and its two controls are supported. Any
    // additional send editor/control or an attachment invalidates this snapshot.
    if ([...entry.querySelectorAll('button')].some(button => button !== sendButton && button.getAttribute('aria-label') !== 'Add image')) return null
    if (this.attachmentEntries.has(entry) || entry.querySelector('img') || [...entry.querySelectorAll('input[type="file"]')].some(input => input.files?.length)) return null
    return { route, thread, entry, composer, sendButton }
  }
  async refresh() {
    const found = this.inspect()
    if (!found) { this.current = null; return false }
    const conversationId = 'gv_' + await digest(found.route), now = this.inspect()
    if (!now || now.route !== found.route || now.composer !== found.composer || now.sendButton !== found.sendButton || now.thread !== found.thread) { this.current = null; return false }
    this.current = { ...now, conversationId }; return true
  }
  get supported() { return !!this.snapshot() }
  snapshot() {
    const now = this.inspect(), current = this.current
    if (!now || !current || now.route !== current.route || now.thread !== current.thread || now.composer !== current.composer || now.sendButton !== current.sendButton) return null
    return { conversationId: current.conversationId, text: now.composer.value, revision: this.revisions.get(now.composer) || 0, composer: now.composer, sendButton: now.sendButton }
  }
  eventIntent(event) {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
    if (!target) return null
    if (event.type === 'submit' && target.matches('form') && target.querySelector('gv-message-entry')) return 'send'
    const entry = target.closest('gv-message-entry')
    if (!entry) return null
    const transfer = event.type === 'paste' ? event.clipboardData : event.type === 'drop' ? event.dataTransfer : null
    if (transfer && (transfer.files?.length || [...transfer.items || []].some(item => item.kind === 'file'))) return 'attachment'
    if (event.type === 'click' && (target.closest('button[aria-label="Add image"]') || target.matches('input[type="file"]'))) return 'attachment'
    if (event.type === 'click' && target.closest('button.send-button')) return target.closest('button.send-button') === this.allowedButton ? null : 'send'
    if (event.type === 'submit') return 'send'
    if (!target.matches('textarea.message-input')) return null
    if ((event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) || event.type === 'beforeinput' && event.inputType === 'insertParagraph') return 'send'
    return null
  }
  isSendEvent(event) { return this.eventIntent(event) === 'send' }
  replace(original, text) {
    const now = this.snapshot()
    if (!now || now.conversationId !== original.conversationId || now.composer !== original.composer || now.sendButton !== original.sendButton || now.text !== original.text || now.revision !== original.revision) return false
    const setter = Object.getOwnPropertyDescriptor(this.document.defaultView.HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) return false
    setter.call(now.composer, text)
    now.composer.dispatchEvent(new this.document.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }))
    this.lastWrite = this.snapshot()
    return now.composer.value === text
  }
  async settle() {
    const expected = this.lastWrite, view = this.document.defaultView
    await new Promise((resolve, reject) => {
      let frame, done = false
      const timer = view.setTimeout(() => { done = true; view.cancelAnimationFrame(frame); reject(new Error('页面未完成输入更新，请核对发送状态。')) }, 1500)
      frame = view.requestAnimationFrame(() => { if (!done) frame = view.requestAnimationFrame(() => { if (!done) { done = true; view.clearTimeout(timer); resolve() } }) })
    })
    const now = this.snapshot()
    if (!now || !expected || now.composer !== expected.composer || now.sendButton !== expected.sendButton || now.conversationId !== expected.conversationId || now.text !== expected.text || now.revision !== expected.revision) throw new Error('输入更新期间草稿或会话变化，请核对发送状态。')
  }
  dispatch(current) {
    const now = this.snapshot()
    if (!now || now.conversationId !== current.conversationId || now.composer !== current.composer || now.sendButton !== current.sendButton || now.text !== current.text || now.sendButton.disabled) throw new Error('发送前页面已变化，请核对草稿。')
    this.allowedButton = now.sendButton
    try { now.sendButton.click() } finally { this.allowedButton = null }
  }
  async messages() {
    if (!this.snapshot()) return []
    const current = this.current, candidates = []
    for (const element of current.thread.querySelectorAll('gv-message-list gv-message-item')) {
      const content = [...element.querySelectorAll('gv-annotation.content')], full = element.querySelector('div.full-container'), row = element.querySelector('div.message-row')
      // Absence of .outgoing alone is never evidence of an incoming message.
      const outgoing = full?.classList.contains('outgoing') && row?.classList.contains('outgoing') && !full.classList.contains('incoming')
      const incoming = full?.classList.contains('incoming') && row && !row.classList.contains('outgoing') && !full.classList.contains('outgoing')
      if (content.length !== 1 || !outgoing && !incoming) continue
      const text = sourceText(content[0]), access = [...element.querySelectorAll('.cdk-visually-hidden')], status = element.querySelector('div.status')
      if (!text || Array.from(text).length > 8000 || access.length !== 1 || !status) continue
      const hidden = sourceText(access[0]), shortTime = sourceText(status), timestamp = hidden.includes(text) ? hidden.replace(text, '').trim() : ''
      if (!timestamp || !/\b20\d{2}\b/.test(timestamp) || !shortTime || shortTime.length > 100) continue
      const direction = outgoing ? 'outgoing' : 'incoming'
      candidates.push({ element, content: content[0], text, timestamp, shortTime, direction, conversationId: current.conversationId, signature: JSON.stringify([current.conversationId, direction, timestamp, text]) })
    }
    for (const item of candidates) {
      // This is a translation-content key, not an asserted official message ID.
      // Unresolvable same-time/same-text entities reuse one result and charge,
      // including when virtualization shows them separately. Never guess ordinal
      // identities and charge again merely to match an apparent SMS count.
      item.id = hashUuid(await digest(item.signature)); item.automatic = true
    }
    return this.snapshot()?.conversationId === current.conversationId ? candidates : []
  }
  validMessage(item) { return item.element.isConnected && this.snapshot()?.conversationId === item.conversationId && sourceText(item.content) === item.text }
  visibleMessage(item) {
    const rect = item.element.getBoundingClientRect(), view = this.document.defaultView
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight && rect.right > 0 && rect.left < view.innerWidth
  }
  dispose() { this.document.defaultView.removeEventListener('input', this.onInput, true); this.document.defaultView.removeEventListener('change', this.onInput, true) }
}
