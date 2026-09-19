import { textValue, translatedValue, translationPayload } from './protocol.mjs'

const hasForbiddenHan = (text, language) => !/^(zh|ja)(?:-|$)/i.test(language) && /\p{Script=Han}/u.test(text)
const sameTarget = (a, b) => a && b && a.conversationId === b.conversationId && a.composer === b.composer && a.sendButton === b.sendButton
const sameDraft = (a, b) => sameTarget(a, b) && a.text === b.text && a.revision === b.revision

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
    this.state = 'idle'; this.job = null
  }
  assertSupported() { if (this.adapter.supported !== true) throw new Error('页面版本尚未支持；发送保护未启用。') }
  async prepare() {
    this.assertSupported()
    if (['preparing', 'authorizing'].includes(this.state)) throw new Error('当前请求处理中，不可重复发送。')
    const original = this.adapter.snapshot()
    if (!original) throw new Error('无法确认当前对话和输入框，已阻止翻译发送。')
    textValue(original.text)
    if (this.state === 'uncertain') {
      if (this.job && this.job.original.conversationId === original.conversationId && [this.job.original.text, this.job.translated?.text].includes(original.text)) throw new Error('当前请求待确认，不可重复发送。')
      this.state = 'idle'; this.job = null
    }
    // Explicit retry of the same failed draft retains its logical request ID.
    if (!this.job || !sameDraft(this.job.original, original)) this.job = { id: this.randomId(), original }
    const job = this.job
    this.state = 'preparing'
    try {
      const status = await this.bridge.status()
      if (!status.connected || typeof status.targetLanguage !== 'string') throw new Error('客户端未连接或目标语言未就绪。')
      if (this.bridge.dispatchStatus) {
        const pending = await this.bridge.dispatchStatus({ conversationId: original.conversationId, text: original.text })
        if (pending.state === 'uncertain') {
          if (!Number.isSafeInteger(pending.attempt) || pending.attempt < 1) throw new Error('此前发送记录无效。')
          job.pendingRequestId = pending.requestId; job.pendingAttempt = pending.attempt; this.state = 'uncertain'; throw new Error('此前发送结果尚未核对，请先确认是否已发送。')
        }
        if (pending.state !== 'clear') throw new Error('无法核对此前发送状态。')
      }
      if (this.bridge.logicalId) {
        const result = await this.bridge.logicalId({ conversationId: original.conversationId, text: original.text })
        if (!result || !/^[a-f0-9-]{36}$/i.test(result.id)) throw new Error('草稿编号尚未确认。')
        job.id = result.id
      }
      if (!sameDraft(original, this.adapter.snapshot())) throw new Error('草稿或会话已变化，未提交翻译。')
      const payload = translationPayload({ id: job.id, direction: 'outgoing', conversationId: original.conversationId, text: original.text })
      const translated = translatedValue(await this.bridge.translate(payload))
      if (hasForbiddenHan(translated.text, status.targetLanguage)) throw new Error('译文仍含中文，已阻止发送。')
      if (!sameDraft(original, this.adapter.snapshot())) throw new Error('对话或草稿已变化，已阻止发送。')
      job.translated = translated; job.targetLanguage = status.targetLanguage
      this.state = 'preview'
      return { text: translated.text, requestId: translated.requestId, untranslated: translated.untranslated === true }
    } catch (error) { if (this.state !== 'uncertain') this.state = 'failed'; throw error }
  }
  async confirm() {
    this.assertSupported()
    if (this.state !== 'preview' || !this.job?.translated) throw new Error('请先成功翻译并确认预览。')
    const job = this.job, original = job.original
    if (!sameDraft(original, this.adapter.snapshot())) { this.state = 'failed'; throw new Error('草稿已变化，已阻止发送。') }
    this.state = 'authorizing'
    try {
      // Host must validate current owner/record/language/wallet/settled translation.
      const result = await this.bridge.authorize({ id: job.id, conversationId: original.conversationId, text: original.text, translated: job.translated.text, requestId: job.translated.requestId })
      if (result?.authorized !== true || result.requestId !== job.translated.requestId || !Number.isSafeInteger(result.attempt) || result.attempt < 1) throw new Error('发送授权未完成，已保留草稿。')
      // Authorization has durably reserved this dispatch. Even DOM write failure
      // now requires explicit outcome reconciliation before any further attempt.
      this.state = 'uncertain'; job.pendingRequestId = job.translated.requestId; job.pendingAttempt = result.attempt
      if (!sameDraft(original, this.adapter.snapshot())) throw new Error('对话或草稿已变化，已阻止发送。')
      if (hasForbiddenHan(job.translated.text, job.targetLanguage)) throw new Error('译文仍含中文，已阻止发送。')
      if (!this.adapter.replace(original, job.translated.text)) throw new Error('译文未写入，已阻止发送。')
      if (this.adapter.settle) await this.adapter.settle()
      const current = this.adapter.snapshot()
      if (!sameTarget(original, current) || current.text !== job.translated.text || hasForbiddenHan(current.text, job.targetLanguage)) throw new Error('输入框或目标核对失败，已阻止发送。')
      // No await between final target/text checks and the only permitted click.
      // Mark uncertain BEFORE dispatch: a thrown/unknown click must never replay.
      this.state = 'uncertain'
      this.adapter.dispatch(current)
      return { state: 'uncertain', requestId: job.translated.requestId }
    } catch (error) { if (this.state !== 'uncertain') this.state = 'failed'; throw error }
  }
  async resolve(outcome) {
    const job = this.job
    if (this.state !== 'uncertain' || !job?.pendingRequestId || !job.pendingAttempt || !['sent', 'not-sent'].includes(outcome) || !this.bridge.dispatchResolve) throw new Error('没有可核对的发送记录。')
    const result = await this.bridge.dispatchResolve({ conversationId: job.original.conversationId, requestId: job.pendingRequestId, attempt: job.pendingAttempt, outcome, confirmed: true })
    if (result?.resolved !== true) throw new Error('发送结果核对未完成。')
    this.state = 'idle'; this.job = null
    return result
  }
}

/** Install ONLY after an adapter identifies the send surfaces it controls.
 * The production DOM adapter rejects unknown editors and known media controls.
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
