import { draftTextValue, translatedTextValue, mediaValue, recipientContextValue, translatedValue, translationPayload } from './protocol.mjs'

const hasForbiddenHan = (text, blockChinese = true) => blockChinese !== false && /\p{Script=Han}/u.test(text)
const policyRevision = status => Number.isSafeInteger(status?.sendPolicyRevision) && status.sendPolicyRevision >= 0 ? status.sendPolicyRevision : 0
const sameTarget = (a, b) => a && b && a.conversationId === b.conversationId && JSON.stringify(a.context) === JSON.stringify(b.context) && a.composer === b.composer && a.sendButton === b.sendButton
const sameMedia = (a, b) => JSON.stringify(a?.media) === JSON.stringify(b?.media) && a?.mediaRevision === b?.mediaRevision
const sameDraft = (a, b) => sameTarget(a, b) && sameMedia(a, b) && a.text === b.text && a.revision === b.revision
const assertSendReady = original => { if (original.sendButton?.disabled || original.sendButton?.getAttribute?.('aria-disabled') === 'true') throw new Error('Google Voice 发送按钮暂不可用。请保留草稿，等待图片或网络恢复后重新预览。') }
const mediaFields = original => ({ ...(original.media ? { media: mediaValue(original.media) } : {}), ...(original.context ? { context: recipientContextValue(original.context) } : {}) })

/**
 * Site-independent send guard; a concrete adapter must verify its DOM surface.
 * snapshot(): {conversationId,text,revision,composer,sendButton} or null
 * replace(snapshot,text): synchronous boolean; recheck current destination itself.
 * dispatch(snapshot): synchronous one-shot click; only exact button bypasses guard.
 * Actual adapter must also reconcile durable sent/uncertain records before reuse.
 */
export class SendGuard {
  constructor(adapter, bridge, { randomId = () => crypto.randomUUID() } = {}) {
    this.adapter = adapter; this.bridge = bridge; this.randomId = randomId
    this.state = 'idle'; this.job = null; this.previewRevision = 0
  }
  invalidate() { this.invalidated = true; this.previewRevision++; this.state = 'failed'; this.job = null }
  dismissPreview() {
    this.previewRevision++
    // Closing UI does not cancel a paid translation or discard its durable ID.
    // An authorization already in flight must finish learning its reservation;
    // an uncertain submission can only be released by explicit reconciliation.
    if (['preparing', 'preview'].includes(this.state)) this.state = 'idle'
  }
  assertPreviewCurrent(revision) {
    this.assertSupported()
    if (revision !== this.previewRevision) throw new Error('预览已关闭，请重新打开草稿预览。')
  }
  assertSupported() { if (this.invalidated) throw new Error('账号或页面已变化，请重新准备预览。'); if (this.adapter.supported !== true) throw new Error('页面版本尚未支持；发送保护未启用。') }
  async prepare() {
    this.assertSupported()
    if (['preparing', 'authorizing'].includes(this.state)) throw new Error('当前请求处理中，不可重复发送。')
    const original = this.adapter.snapshot()
    if (!original) throw new Error('无法确认当前对话和输入框，已阻止翻译发送。')
    // A draft may contain an expanded, already-paid translation after an
    // interrupted send. Reconcile that receipt before applying the narrower
    // source limit to any NEW translation request.
    translatedTextValue(original.text, mediaValue(original.media))
    if (this.state === 'uncertain') {
      if (this.job && this.job.original.conversationId === original.conversationId && sameMedia(this.job.original, original) && [this.job.original.text, this.job.translated?.text].includes(original.text)) throw new Error('当前请求待确认，不可重复发送。')
      this.state = 'idle'; this.job = null
    }
    // Explicit retry of the same failed draft retains its logical request ID.
    if (!this.job || !sameDraft(this.job.original, original)) this.job = { id: this.randomId(), original }
    const job = this.job, revision = this.previewRevision
    this.state = 'preparing'
    try {
      const status = await this.bridge.status()
      this.assertPreviewCurrent(revision)
      if (!status.connected || typeof status.targetLanguage !== 'string') throw new Error('客户端未连接或目标语言未就绪。')
      if (this.bridge.dispatchStatus) {
        const pending = await this.bridge.dispatchStatus({ conversationId: original.conversationId, text: original.text, ...mediaFields(original) })
        this.assertPreviewCurrent(revision)
        if (pending.state === 'uncertain') {
          if (!Number.isSafeInteger(pending.attempt) || pending.attempt < 1) throw new Error('此前发送记录无效。')
          job.pendingRequestId = pending.requestId; job.pendingAttempt = pending.attempt; this.state = 'uncertain'; throw new Error('此前发送结果尚未核对，请先确认是否已发送。')
        }
        if (pending.state !== 'clear') throw new Error('无法核对此前发送状态。')
      }
      draftTextValue(original.text, mediaValue(original.media))
      assertSendReady(original)
      if (this.bridge.logicalId) {
        const result = await this.bridge.logicalId({ conversationId: original.conversationId, text: original.text, ...mediaFields(original) })
        this.assertPreviewCurrent(revision)
        if (!result || !/^[a-f0-9-]{36}$/i.test(result.id)) throw new Error('草稿编号尚未确认。')
        job.id = result.id
      }
      if (!sameDraft(original, this.adapter.snapshot())) throw new Error('草稿或会话已变化，未提交翻译。')
      assertSendReady(original)
      const payload = translationPayload({ id: job.id, direction: 'outgoing', conversationId: original.conversationId, text: original.text, ...mediaFields(original) })
      const translated = translatedValue(await this.bridge.translate(payload))
      this.assertPreviewCurrent(revision)
      if (JSON.stringify(translated.media) !== JSON.stringify(original.media)) throw new Error('图片草稿回执不一致，已阻止发送。')
      if (hasForbiddenHan(translated.text, status.blockChineseSend)) throw new Error('译文仍含中文，已阻止发送。')
      if (status.blockChineseSend === false && /\p{Script=Han}/u.test(original.text) && (translated.text !== original.text || !translated.untranslated)) throw new Error('已关闭禁止发送中文，请重新发送原文。')
      if (!sameDraft(original, this.adapter.snapshot())) throw new Error('对话或草稿已变化，已阻止发送。')
      job.translated = translated; job.targetLanguage = status.targetLanguage; job.blockChinese = status.blockChineseSend !== false; job.sendPolicyRevision = policyRevision(status)
      this.state = 'preview'
      return { text: translated.text, requestId: translated.requestId, untranslated: translated.untranslated === true, ...mediaFields(original) }
    } catch (error) { if (revision === this.previewRevision && this.state !== 'uncertain') this.state = 'failed'; throw error }
  }
  async confirm() {
    this.assertSupported()
    if (this.state !== 'preview' || !this.job?.translated) throw new Error('请先成功翻译并确认预览。')
    const job = this.job, original = job.original, revision = this.previewRevision
    if (!sameDraft(original, this.adapter.snapshot())) { this.state = 'failed'; throw new Error('草稿已变化，已阻止发送。') }
    assertSendReady(original)
    this.state = 'authorizing'
    try {
      // Host must validate current owner/record/language/wallet/settled translation.
      const result = await this.bridge.authorize({ id: job.id, conversationId: original.conversationId, text: original.text, translated: job.translated.text, requestId: job.translated.requestId, ...mediaFields(original) })
      this.assertSupported()
      if (result?.authorized !== true || result.requestId !== job.translated.requestId || !Number.isSafeInteger(result.attempt) || result.attempt < 1) throw new Error('发送授权未完成，已保留草稿。')
      // Authorization has durably reserved this dispatch. Even DOM write failure
      // now requires explicit outcome reconciliation before any further attempt.
      this.state = 'uncertain'; job.pendingRequestId = job.translated.requestId; job.pendingAttempt = result.attempt
      this.assertPreviewCurrent(revision)
      if (!sameDraft(original, this.adapter.snapshot())) throw new Error('对话或草稿已变化，已阻止发送。')
      if (hasForbiddenHan(job.translated.text, job.blockChinese)) throw new Error('译文仍含中文，已阻止发送。')
      if (!this.adapter.replace(original, job.translated.text)) throw new Error('译文未写入，已阻止发送。')
      if (this.adapter.settle) await this.adapter.settle()
      this.assertPreviewCurrent(revision)
      // Editor settlement is asynchronous. Read live policy again after it,
      // including a monotonic host revision to catch OFF -> ON -> OFF changes.
      // Status is read-only: never reserve a second dispatch or retranslate.
      const status = await this.bridge.status()
      this.assertPreviewCurrent(revision)
      if (!status.connected || status.targetLanguage !== job.targetLanguage || (status.blockChineseSend !== false) !== job.blockChinese || policyRevision(status) !== job.sendPolicyRevision) throw new Error('中文发送设置或连接已变化，已阻止发送，请重新核对草稿。')
      if (hasForbiddenHan(job.translated.text, status.blockChineseSend) || status.blockChineseSend === false && /\p{Script=Han}/u.test(original.text) && (job.translated.text !== original.text || !job.translated.untranslated)) throw new Error('中文发送设置核对失败，已阻止发送并保留草稿。')
      const current = this.adapter.snapshot()
      if (!sameTarget(original, current) || !sameMedia(original, current) || current.text !== job.translated.text || hasForbiddenHan(current.text, job.blockChinese)) throw new Error('输入框、图片或目标核对失败，已阻止发送。')
      // No await between final target/text checks and the only permitted click.
      // Mark uncertain BEFORE dispatch: a thrown/unknown click must never replay.
      this.state = 'uncertain'
      this.adapter.dispatch(current)
      return { state: 'uncertain', requestId: job.translated.requestId }
    } catch (error) { if (this.state !== 'uncertain') this.state = 'failed'; throw error }
  }
  async resolve(outcome) {
    this.assertSupported()
    const job = this.job
    if (this.state !== 'uncertain' || !job?.pendingRequestId || !job.pendingAttempt || !['sent', 'not-sent'].includes(outcome) || !this.bridge.dispatchResolve) throw new Error('没有可核对的发送记录。')
    const result = await this.bridge.dispatchResolve({ conversationId: job.original.conversationId, requestId: job.pendingRequestId, attempt: job.pendingAttempt, outcome, confirmed: true, ...mediaFields(job.original) })
    this.assertSupported()
    if (result?.resolved !== true) throw new Error('发送结果核对未完成。')
    this.state = 'idle'; this.job = null
    return result
  }
}

/** Install ONLY after an adapter identifies the send surfaces it controls.
 * The production DOM adapter rejects unknown editors and unverified attachments.
 * An extension disabled by the user cannot guard the official page.
 */
export function installSendInterception(target, adapter, onIntent, reportError = () => {}) {
  if (adapter.supported !== true) throw new Error('尚未验证页面适配。')
  const stop = event => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation() }
  const handler = event => {
    if (!adapter.isSendEvent(event)) return
    stop(event)
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) return
    // Native replay is handled inside a concrete adapter and is exact-button
    // scoped; this generic gate has no global timed allow-send window.
    if (event.type === 'keyup' || event.type === 'keypress' || event.type === 'beforeinput') return
    Promise.resolve().then(onIntent).catch(reportError)
  }
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'click', 'submit']) target.addEventListener(type, handler, true)
  return () => { for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'click', 'submit']) target.removeEventListener(type, handler, true) }
}
