import { digest } from './protocol.mjs'

const one = (root, selector) => { const found = [...root.querySelectorAll(selector)].filter(node => node.getClientRects().length > 0); return found.length === 1 ? found[0] : null }
// Translations live inside the official text bubble. Exclude our entire UI
// subtree so a redraw never turns the previous translation into source text,
// changes a message's durable identity or charges for the same SMS again.
const sourceText = node => {
  if (!node) return ''
  const walker = node.ownerDocument.createTreeWalker(node, 4 /* SHOW_TEXT */)
  const parts = []
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('[data-hellodog-voice]')) parts.push(walker.currentNode.nodeValue || '')
  return parts.join('').trim()
}
const hashUuid = value => `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp'])
const imageFiles = files => files.length > 0 && files.length <= 10 && files.every(file => imageTypes.has(file.type) && file.size > 0 && (file.type !== 'image/gif' || file.size <= 2 * 1024 * 1024)) && files.reduce((total, file) => total + file.size, 0) <= 20 * 1024 * 1024
const sameAdapterMedia = (a, b) => JSON.stringify(a?.media) === JSON.stringify(b?.media) && a?.mediaRevision === b?.mediaRevision
const recipientNumber = text => {
  const value = (text || '').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  if (!/^[+()\d\s.\-]+$/.test(value)) return null
  const number = value.replace(/[()\s.\-]/g, '')
  if (/^\+[1-9]\d{7,14}$/.test(number)) return number
  // Official selected NANP chips display the national ten-digit form. Do not
  // infer a destination from a contact name or an incomplete number input.
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(number)) return '+1' + number
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(number)) return '+' + number
  return null
}

/** Selectors verified read-only against the official English SMS page.
 * Incoming/outgoing text verified read-only on 2026-09-18; selected recipient
 * chips and the draft route observed on 2026-09-20. Image drafts are
 * accepted only when selected File bytes and the native preview can be bound.
 * All reads are rendered DOM; no private framework state, requests or cookies.
 */
export class GoogleVoiceDomAdapter {
  constructor(document, location) {
    this.document = document; this.location = location; this.current = null
    this.revisions = new WeakMap(); this.attachments = new WeakMap(); this.allowedButton = null
    this.settleCancels = new Set(); this.disposed = false
    this.onInput = event => {
      if (event.target?.matches?.('gv-message-entry textarea.message-input')) this.revisions.set(event.target, (this.revisions.get(event.target) || 0) + 1)
      if (event.type === 'change' && event.target?.matches?.('gv-message-entry input[type="file"]')) {
        const files = [...event.target.files || []]
        if (files.length && !imageFiles(files)) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation() }
        this.captureFiles(event.target.closest('gv-message-entry'), files)
      }
    }
    document.defaultView.addEventListener('input', this.onInput, true)
    document.defaultView.addEventListener('change', this.onInput, true)
  }
  captureFiles(entry, files) {
    const previous = this.attachments.get(entry), record = { revision: (previous?.revision || 0) + 1, files, work: true, media: undefined, seenPreview: false, cleared: false, previewSignature: '', initialPreviews: [...entry.querySelectorAll('img')].map(image => ({ image, src: image.currentSrc || image.getAttribute('src') || '' })), previousFingerprint: previous?.media?.fingerprint, error: '' }
    this.attachments.set(entry, record)
    if (!imageFiles(files)) { record.work = false; record.error = files.length ? '仅支持 JPEG、PNG、GIF 或 BMP 图片，最多 10 张、合计 20 MB；单张 GIF 不超过 2 MB。视频和音频附件不在此发送范围内。' : ''; record.cleared = !files.length; entry.dispatchEvent(new this.document.defaultView.Event('hellodog-voice-draft-ready', { bubbles: true })); return }
    void (async () => {
      const fingerprints = []
      for (const file of files) fingerprints.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join(''))
      const media = { fingerprint: await digest(JSON.stringify(files.map((file, index) => [file.type, file.size, fingerprints[index]]))), count: files.length, types: files.map(file => file.type), totalBytes: files.reduce((total, file) => total + file.size, 0) }
      if (this.disposed || this.attachments.get(entry) !== record) return
      record.media = media
    })().catch(() => { if (!this.disposed && this.attachments.get(entry) === record) record.error = '图片无法核实，请移除后重新选择。' }).finally(() => {
      record.work = false
      if (!this.disposed && this.attachments.get(entry) === record) entry.dispatchEvent(new this.document.defaultView.Event('hellodog-voice-draft-ready', { bubbles: true }))
    })
  }
  attachmentSnapshot(entry) {
    const previews = [...entry.querySelectorAll('img')]
    let record = this.attachments.get(entry)
    const files = [...entry.querySelectorAll('input[type="file"]')].flatMap(input => [...input.files || []])
    if (!record && files.length) { this.captureFiles(entry, files); record = this.attachments.get(entry) }
    if (record?.error) return { error: record.error }
    if (record?.work) return { error: '正在核实图片，请稍候。' }
    if (!previews.length) {
      if (record?.seenPreview) { record.cleared = true; record.media = undefined; record.files = []; record.revision++; record.seenPreview = false }
      if (record?.media && !record.cleared) return { error: '图片尚未完成官方预览，请稍候。' }
      return { mediaRevision: record?.revision || 0 }
    }
    if (!record?.media || record.cleared || previews.length !== record.media.count) return { error: '无法核实全部图片，请移除草稿图片后重新选择。' }
    if (entry.querySelector('[role="progressbar"],mat-progress-spinner,mat-spinner,progress')) return { error: '图片仍在准备，请等官方预览完成。' }
    if (previews.some(image => !image.getClientRects().length || !image.complete || image.naturalWidth < 1)) return { error: '图片预览尚未加载完成，请稍候。' }
    const signature = JSON.stringify(previews.map(image => image.currentSrc || image.getAttribute('src') || ''))
    if (!record.seenPreview && record.initialPreviews.length && record.previousFingerprint !== record.media.fingerprint && previews.every(image => record.initialPreviews.some(before => before.image === image && before.src === (image.currentSrc || image.getAttribute('src') || '')))) return { error: '正在等待所选图片的官方预览，请稍候。' }
    if (record.seenPreview && record.previewSignature !== signature) { record.error = '图片预览已变化，请移除图片后重新选择。'; return { error: record.error } }
    record.seenPreview = true; record.previewSignature = signature
    return { media: { ...record.media, types: [...record.media.types] }, mediaRevision: record.revision }
  }
  route() {
    try {
      const url = new URL(this.location.href), item = url.searchParams.get('itemId')
      if (url.origin !== 'https://voice.google.com' || !/^\/u\/\d+\/messages\/?$/.test(url.pathname) || !item?.startsWith('t.') || item.length <= 2 || item.length > 1024) return null
      return JSON.stringify([url.pathname.replace(/\/$/, ''), item])
    } catch { return null }
  }
  recipients() {
    let url
    try { url = new URL(this.location.href) } catch { return null }
    if (url.origin !== 'https://voice.google.com' || !/^\/u\/\d+\/messages\/?$/.test(url.pathname) || url.searchParams.get('itemId') !== 'draft') return null
    const picker = one(this.document, 'gv-message-party-picker'), grid = picker && one(picker, 'mat-chip-grid'), input = picker && one(picker, 'input.mat-mdc-chip-input')
    if (!grid || !input || input.value.trim()) return null
    const chips = [...grid.querySelectorAll('mat-chip-row.chip-row')]
    if (!chips.length || chips.length > 7 || chips.some(chip => !chip.getClientRects().length)) return null
    const numbers = []
    for (const chip of chips) {
      const accessible = chip.querySelectorAll('.cdk-visually-hidden'), remove = chip.querySelectorAll('button[gv-test-id="chip-item-remove"]')
      if (accessible.length !== 1 || remove.length !== 1) return null
      const number = recipientNumber(accessible[0].textContent)
      if (!number || numbers.includes(number)) return null
      numbers.push(number)
    }
    numbers.sort()
    return { path: url.pathname.replace(/\/$/, ''), signature: JSON.stringify(numbers), count: numbers.length }
  }
  inspect() {
    if (this.disposed) return null
    this.reason = ''
    const recipients = this.recipients(), route = recipients ? JSON.stringify([recipients.path, 'draft', recipients.signature]) : this.route(), thread = one(this.document, 'gv-thread-details'), entry = one(this.document, 'gv-message-entry')
    if (!route || !thread || !entry || !recipients && this.document.querySelector('gv-message-party-picker')) { this.reason = '请先选择短信会话，或完整选定 1–7 位收件人；待输入号码与未识别收件人不会发送。'; return null }
    const composer = one(entry, 'textarea.message-input'), sendButton = one(entry, 'button.send-button')
    if (!composer || !sendButton || composer.disabled || composer.readOnly || composer.getAttribute('aria-readonly') !== 'false' || composer.closest('form')) return null
    // Stable custom element/class selectors identify the send surface across
    // localized labels. Image controls remain inside the native actions area.
    if ([...entry.querySelectorAll('button')].some(button => button !== sendButton && !button.closest('gv-message-actions') && !/^(?:Add image|添加图片|新增圖片|Remove image|移除图片|删除图片|移除圖片|刪除圖片)$/i.test(button.getAttribute('aria-label') || ''))) { this.reason = '当前编辑器有未识别的操作控件，请保留草稿。'; return null }
    const attachment = this.attachmentSnapshot(entry)
    if (entry.querySelector('video,audio')) { this.reason = '当前仅支持官方图片短信，视频和音频附件不能在此发送。'; return null }
    if (attachment.error) { this.reason = attachment.error; return null }
    return { route, thread, entry, composer, sendButton, recipients, ...attachment }
  }
  async refresh() {
    const found = this.inspect()
    if (!found) { this.current = null; return false }
    const context = found.recipients ? { kind: 'recipients', recipientKey: await digest(found.recipients.signature), recipientCount: found.recipients.count } : undefined
    const conversationId = 'gv_' + await digest(context ? JSON.stringify([found.recipients.path, 'draft', context.recipientKey, context.recipientCount]) : found.route), now = this.inspect()
    if (!now || now.route !== found.route || now.composer !== found.composer || now.sendButton !== found.sendButton || now.thread !== found.thread) { this.current = null; return false }
    this.current = { ...now, conversationId, context }; return true
  }
  get supported() { return !!this.snapshot() }
  snapshot() {
    const now = this.inspect(), current = this.current
    if (!now || !current || now.route !== current.route || now.thread !== current.thread || now.composer !== current.composer || now.sendButton !== current.sendButton) return null
    return { conversationId: current.conversationId, text: now.composer.value, revision: this.revisions.get(now.composer) || 0, composer: now.composer, sendButton: now.sendButton, mediaRevision: now.mediaRevision, ...(current.context ? { context: { ...current.context } } : {}), ...(now.media ? { media: now.media } : {}) }
  }
  eventIntent(event) {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
    if (!target) return null
    if (event.type === 'submit' && target.matches('form') && target.querySelector('gv-message-entry')) return 'send'
    const entry = target.closest('gv-message-entry')
    if (!entry) return null
    const transfer = event.type === 'paste' ? event.clipboardData : event.type === 'drop' ? event.dataTransfer : null
    if (transfer && (transfer.files?.length || [...transfer.items || []].some(item => item.kind === 'file'))) {
      const files = [...transfer.files || []]
      if (!imageFiles(files)) return 'attachment'
      this.captureFiles(entry, files)
      return null
    }
    if (event.type === 'click' && target.closest('button.send-button')) return target.closest('button.send-button') === this.allowedButton ? null : 'send'
    if (event.type === 'submit') return 'send'
    if (!target.matches('textarea.message-input')) return null
    if ((event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) || event.type === 'beforeinput' && event.inputType === 'insertParagraph') return 'send'
    return null
  }
  isSendEvent(event) { return this.eventIntent(event) === 'send' }
  replace(original, text) {
    const now = this.snapshot()
    if (!now || now.conversationId !== original.conversationId || now.composer !== original.composer || now.sendButton !== original.sendButton || now.text !== original.text || now.revision !== original.revision || !sameAdapterMedia(original, now)) return false
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
      const finish = error => { if (done) return; done = true; view.clearTimeout(timer); view.cancelAnimationFrame(frame); this.settleCancels.delete(cancel); error ? reject(error) : resolve() }
      const cancel = () => finish(new Error('页面已离开，请核对发送状态。'))
      const timer = view.setTimeout(() => finish(new Error('页面未完成输入更新，请核对发送状态。')), 1500)
      this.settleCancels.add(cancel)
      if (this.disposed) { cancel(); return }
      frame = view.requestAnimationFrame(() => { if (!done) frame = view.requestAnimationFrame(() => finish()) })
    })
    const now = this.snapshot()
    if (!now || !expected || now.composer !== expected.composer || now.sendButton !== expected.sendButton || now.conversationId !== expected.conversationId || now.text !== expected.text || now.revision !== expected.revision || !sameAdapterMedia(expected, now)) throw new Error('输入更新期间草稿、图片或会话变化，请核对发送状态。')
  }
  dispatch(current) {
    const now = this.snapshot()
    if (!now || now.conversationId !== current.conversationId || now.composer !== current.composer || now.sendButton !== current.sendButton || now.text !== current.text || !sameAdapterMedia(current, now) || now.sendButton.disabled) throw new Error('发送前页面已变化，请核对草稿。')
    this.allowedButton = now.sendButton
    try { now.sendButton.click() } finally { this.allowedButton = null }
  }
  async messages() {
    const route = this.route(), thread = one(this.document, 'gv-thread-details')
    if (!route || !thread || this.disposed) return []
    const current = { route, thread, conversationId: 'gv_' + await digest(route) }, candidates = []
    if (this.route() !== route || one(this.document, 'gv-thread-details') !== thread || this.disposed) return []
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
      candidates.push({ element, content: content[0], text, timestamp, shortTime, direction, route, thread, conversationId: current.conversationId, signature: JSON.stringify([current.conversationId, direction, timestamp, text]) })
    }
    for (const item of candidates) {
      // This is a translation-content key, not an asserted official message ID.
      // Unresolvable same-time/same-text entities reuse one result and charge,
      // including when virtualization shows them separately. Never guess ordinal
      // identities and charge again merely to match an apparent SMS count.
      item.id = hashUuid(await digest(item.signature)); item.automatic = true
    }
    return !this.disposed && this.route() === route && one(this.document, 'gv-thread-details') === thread ? candidates : []
  }
  validMessage(item) { return !this.disposed && item.element.isConnected && item.content.isConnected && item.element.contains(item.content) && item.thread?.contains(item.element) && one(this.document, 'gv-thread-details') === item.thread && this.route() === item.route && sourceText(item.content) === item.text }
  visibleMessage(item) {
    const rect = item.element.getBoundingClientRect(), view = this.document.defaultView
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight && rect.right > 0 && rect.left < view.innerWidth
  }
  dispose() { this.disposed = true; this.current = null; for (const cancel of this.settleCancels) cancel(); this.document.defaultView.removeEventListener('input', this.onInput, true); this.document.defaultView.removeEventListener('change', this.onInput, true) }
}
