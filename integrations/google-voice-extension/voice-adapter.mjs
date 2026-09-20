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
const encodedBytes = bytes => { const parts = []; for (let index = 0; index < bytes.length; index += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000))); return btoa(parts.join('')) }
const cssImageToken = value => {
  const match = value.match(/^url\(["']?data:(image\/(?:jpeg|png|gif|bmp));base64,([A-Za-z0-9+/=]+)["']?\)$/i)
  return match ? match[1].toLowerCase() + ';' + match[2] : null
}
const identicalPreviewTokens = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
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
    this.settleCancels = new Set(); this.mediaTimers = new Set(); this.disposed = false
    this.onInput = event => {
      if (event.target?.matches?.('gv-message-entry textarea.message-input')) this.revisions.set(event.target, (this.revisions.get(event.target) || 0) + 1)
      if (event.type === 'change' && event.target?.matches?.('gv-message-entry input[type="file"]')) {
        const files = [...event.target.files || []]
        if (files.length && !imageFiles(files)) {
          event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
          // The site never receives this rejected selection. Preserve its
          // existing draft, and do not leave rejected input.files to be seeded
          // as a future attachment after the user continues typing.
          event.target.value = ''
          event.target.dispatchEvent(new this.document.defaultView.Event('hellodog-voice-attachment-rejected', { bubbles: true }))
          return
        }
        if (!files.length) return
        this.captureFiles(event.target.closest('gv-message-entry'), files)
      }
    }
    document.defaultView.addEventListener('input', this.onInput, true)
    document.defaultView.addEventListener('change', this.onInput, true)
    this.onAttachmentRemove = event => {
      const remove = event.target?.closest?.('gv-message-entry gv-send-attachment-list span.close-icon-overlay[role="button"]')
      const record = remove && this.attachments.get(remove.closest('gv-message-entry'))
      if (record) record.removeRequested = true
    }
    document.defaultView.addEventListener('click', this.onAttachmentRemove, true)
  }
  cssPreviews(entry) {
    const roots = [...entry.querySelectorAll('gv-send-attachment-list')]
    if (!roots.length) return null
    if (roots.length !== 1 || !roots[0].getClientRects().length) return { error: '图片编辑器尚未就绪，请保留草稿。' }
    const root = roots[0], grid = one(root, 'div.container[role="grid"]')
    if (!grid) return { error: '当前图片预览结构尚未识别，请保留草稿。' }
    const cells = [...grid.querySelectorAll('[role="gridcell"]')]
    if (cells.some(cell => !cell.matches('div.item') || cell.parentElement?.getAttribute('role') !== 'row')) return { error: '当前图片预览结构尚未识别，请保留草稿。' }
    const previews = []
    for (const cell of cells) {
      const content = one(cell, 'div.content'), remove = one(cell, 'span.close-icon-overlay[role="button"]')
      if (!content || !remove) return { error: '图片预览尚未就绪，请保留草稿。' }
      const background = this.document.defaultView.getComputedStyle(content).backgroundImage
      previews.push({ content, remove, token: cssImageToken(background), pending: !background || background === 'none' })
    }
    return { root, previews }
  }
  mediaReady(entry) { if (!this.disposed && entry.isConnected) entry.dispatchEvent(new this.document.defaultView.Event('hellodog-voice-draft-ready', { bubbles: true })) }
  clearAttachments(entry, record) {
    // Retire the record, including all original bytes. Pending File/decode work
    // compares record identity and cannot resurrect a removed attachment.
    record.files = []; record.knownFiles = []; record.selectedTokens = []; record.initialTokens = []; record.initialPreviews = []
    record.media = undefined; record.cssMedia = undefined; record.cssSignature = undefined; record.previewSignature = ''
    const cleared = { revision: record.revision + 1, files: [], knownFiles: [], selectedTokens: [], initialTokens: [], initialPreviews: [], previewSignature: '', cleared: true, seenPreview: false, selectionPending: false, work: false, error: '' }
    this.attachments.set(entry, cleared)
    return cleared
  }
  captureFiles(entry, files) {
    if (!imageFiles(files)) return
    const previous = this.attachments.get(entry), css = this.cssPreviews(entry)
    const initialTokens = css?.previews?.map(preview => preview.token) || []
    const known = (previous?.knownFiles || []).filter(file => initialTokens.includes(file.token))
    const record = { revision: (previous?.revision || 0) + 1, files, knownFiles: known, selectedTokens: [], initialTokens: previous ? initialTokens : [], selectionPending: true, deadline: Date.now() + 8000, work: true, media: undefined, seenPreview: false, cleared: false, previewSignature: '', initialPreviews: [...entry.querySelectorAll('img')].map(image => ({ image, src: image.currentSrc || image.getAttribute('src') || '' })), previousFingerprint: previous?.media?.fingerprint, error: '' }
    this.attachments.set(entry, record)
    const timer = this.document.defaultView.setTimeout(() => { this.mediaTimers.delete(timer); if (this.attachments.get(entry) === record) this.mediaReady(entry) }, 8050)
    this.mediaTimers.add(timer)
    void (async () => {
      const fingerprints = []
      for (const file of files) {
        if (this.disposed || this.attachments.get(entry) !== record) return
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (this.disposed || this.attachments.get(entry) !== record) return
        const encoded = encodedBytes(bytes)
        const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
        const token = file.type + ';' + encoded, image = new this.document.defaultView.Image()
        image.src = 'data:' + file.type + ';base64,' + encoded
        await image.decode()
        if (this.disposed || this.attachments.get(entry) !== record) return
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('invalid image')
        fingerprints.push(fingerprint); record.selectedTokens.push(token)
        if (!record.knownFiles.some(known => known.token === token)) record.knownFiles.push({ token, type: file.type, size: file.size, fingerprint })
      }
      const media = { fingerprint: await digest(JSON.stringify(files.map((file, index) => [file.type, file.size, fingerprints[index]]))), count: files.length, types: files.map(file => file.type), totalBytes: files.reduce((total, file) => total + file.size, 0) }
      if (this.disposed || this.attachments.get(entry) !== record) return
      record.media = media
    })().catch(() => { if (!this.disposed && this.attachments.get(entry) === record) record.error = '图片无法核实，请移除后重新选择。' }).finally(() => {
      record.work = false
      if (!this.disposed && this.attachments.get(entry) === record) this.mediaReady(entry)
    })
  }
  cssAttachmentSnapshot(entry, css, record) {
    if (css.error) return { error: css.error }
    const previews = css.previews
    if (!previews.length) return null
    if (!record || record.cleared || !record.knownFiles?.length) return { error: '图片未能与所选文件核对，请移除草稿图片后重新选择。' }
    if (previews.some(preview => preview.pending) || entry.querySelector('[role="progressbar"],mat-progress-spinner,mat-spinner,progress')) return { error: Date.now() <= record.deadline ? '图片仍在准备，请等官方预览完成。' : '图片预览未能完成，请移除后重新选择较小图片。' }
    const tokens = previews.map(preview => preview.token)
    const mapped = tokens.map(token => record.knownFiles.find(file => file.token === token))
    if (mapped.some(file => !file)) return { error: '图片预览与所选文件无法核对，请移除后重新选择较小图片。' }
    if (record.selectionPending) {
      // A file change may precede the site's new CSS preview. Never authorize
      // the still-visible old image while a replacement/addition is pending.
      const remaining = [...tokens]
      const includesSelection = record.selectedTokens.every(token => { const index = remaining.indexOf(token); if (index < 0) return false; remaining.splice(index, 1); return true })
      if (identicalPreviewTokens(tokens, record.initialTokens) || !includesSelection) return { error: Date.now() <= record.deadline ? '正在等待所选图片的官方预览，请稍候。' : '所选图片未加入预览，请移除后重新选择较小图片。' }
      record.selectionPending = false
    }
    if (!imageFiles(mapped)) return { error: '图片数量或大小超出范围：最多 10 张、合计 20 MB；单张 GIF 不超过 2 MB。' }
    const signature = JSON.stringify(mapped.map(file => [file.type, file.size, file.fingerprint]))
    if (record.cssSignature !== signature) {
      record.cssSignature = signature; record.cssMedia = undefined; record.revision++
      void digest(signature).then(fingerprint => {
        if (this.disposed || this.attachments.get(entry) !== record || record.cssSignature !== signature) return
        record.cssMedia = { fingerprint, count: mapped.length, types: mapped.map(file => file.type), totalBytes: mapped.reduce((total, file) => total + file.size, 0) }
        this.mediaReady(entry)
      }).catch(() => { record.error = '图片无法核实，请移除后重新选择。'; this.mediaReady(entry) })
    }
    if (!record.cssMedia) return { error: '正在核实图片，请稍候。' }
    record.seenPreview = true; record.media = record.cssMedia
    return { media: { ...record.cssMedia, types: [...record.cssMedia.types] }, mediaRevision: record.revision }
  }
  attachmentSnapshot(entry) {
    const previews = [...entry.querySelectorAll('img')]
    let record = this.attachments.get(entry)
    const files = [...entry.querySelectorAll('input[type="file"]')].flatMap(input => [...input.files || []])
    if (!record && imageFiles(files)) { this.captureFiles(entry, files); record = this.attachments.get(entry) }
    const css = this.cssPreviews(entry)
    const hasProgress = [...entry.querySelectorAll('[role="progressbar"],mat-progress-spinner,mat-spinner,progress')].some(node => node.getClientRects().length)
    const previewsRemoved = !previews.length && !css?.error && !css?.previews?.length && !hasProgress
    if (record && !record.cleared && previewsRemoved && (record.removeRequested || record.seenPreview && !record.selectionPending)) record = this.clearAttachments(entry, record)
    if (record?.error) return { error: record.error }
    if (record?.work) return { error: Date.now() <= record.deadline ? '正在核实图片，请稍候。' : '图片读取未能完成，请移除后重新选择较小图片。' }
    if (css) { const snapshot = this.cssAttachmentSnapshot(entry, css, record); if (snapshot) return snapshot }
    if (!previews.length) {
      if (record?.media && !record.cleared) return { error: Date.now() <= record.deadline ? '图片尚未完成官方预览，请稍候。' : '图片预览未能完成，请移除后重新选择较小图片。' }
      return { mediaRevision: record?.revision || 0 }
    }
    if (!record?.media || record.cleared || previews.length !== record.media.count) return { error: '无法核实全部图片，请移除草稿图片后重新选择。' }
    if (entry.querySelector('[role="progressbar"],mat-progress-spinner,mat-spinner,progress')) return { error: '图片仍在准备，请等官方预览完成。' }
    if (previews.some(image => !image.getClientRects().length || !image.complete || image.naturalWidth < 1)) return { error: '图片预览尚未加载完成，请稍候。' }
    const signature = JSON.stringify(previews.map(image => image.currentSrc || image.getAttribute('src') || ''))
    if (!record.seenPreview && record.initialPreviews.length && record.previousFingerprint !== record.media.fingerprint && previews.every(image => record.initialPreviews.some(before => before.image === image && before.src === (image.currentSrc || image.getAttribute('src') || '')))) return { error: '正在等待所选图片的官方预览，请稍候。' }
    if (record.seenPreview && record.previewSignature !== signature) { record.error = '图片预览已变化，请移除图片后重新选择。'; return { error: record.error } }
    record.seenPreview = true; record.selectionPending = false; record.previewSignature = signature
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
    // Pure images and an unchanged authorized caption need no input write.
    // Avoid making the native editor rebuild attachments for an empty setter.
    if (now.text === text) { this.lastWrite = now; this.lastWriteChanged = false; return true }
    const setter = Object.getOwnPropertyDescriptor(this.document.defaultView.HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) return false
    setter.call(now.composer, text)
    now.composer.dispatchEvent(new this.document.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }))
    this.lastWrite = this.snapshot()
    this.lastWriteChanged = true
    return now.composer.value === text
  }
  async settle() {
    const expected = this.lastWrite, view = this.document.defaultView
    if (this.lastWriteChanged !== false) await new Promise((resolve, reject) => {
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
  dispose() { this.disposed = true; this.current = null; for (const cancel of this.settleCancels) cancel(); for (const timer of this.mediaTimers) this.document.defaultView.clearTimeout(timer); this.mediaTimers.clear(); this.document.defaultView.removeEventListener('input', this.onInput, true); this.document.defaultView.removeEventListener('change', this.onInput, true); this.document.defaultView.removeEventListener('click', this.onAttachmentRemove, true) }
}
