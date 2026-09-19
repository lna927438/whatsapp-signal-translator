import { createHash } from 'crypto'
import type { TranslationReceipt } from '../../translation/receipts'
import type { TranslationRequest } from '../../types'
import type { GoogleVoiceDispatchData } from './dispatchLedger'
import { qualityKey } from '../../../shared/translationPolicy'

const messages = {
  ambiguous: '找到多条可能对应的旧 Google Voice 草稿，请先在翻译记录中核对。本次未重新翻译或扣费。',
  expired: '旧 Google Voice 草稿内容已清理，无法安全恢复，请先核对原翻译记录。本次未重新翻译或扣费。',
  incomplete: '旧 Google Voice 草稿记录不完整，无法安全恢复，请先核对原翻译记录。本次未重新翻译或扣费。',
  uncertain: '此旧短信的发送结果待确认，请先核对发送记录。本次未重新翻译或扣费。',
  sent: '此旧短信已确认发送，请重新打开草稿后作为新消息操作。本次未重新翻译或扣费。',
  settings: '旧草稿的翻译设置与当前设置不同，请先恢复原目标语言和翻译选项，再核对原译文。本次未重新翻译或扣费。'
}
export class GoogleVoiceDraftRecoveryError extends Error {
  constructor(readonly reason: keyof typeof messages) { super(messages[reason]) }
}
function fail(reason: keyof typeof messages): never { throw new GoogleVoiceDraftRecoveryError(reason) }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const rootId = (value: string) => /^send-gv-[a-f0-9]{64}$/.test(value)
const retryId = (value: string) => /^send-retry-[a-f0-9]{64}$/.test(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
type Scope = { owner: string; accountId: string; conversationId: string; text: string }
export type RecoveredGoogleVoiceDraft = { id: string; requestId: string; request: TranslationRequest }

/** Recover a logical unsent draft, never a global same-text cache alias. The
 * old extension's UUID survives in the main process's immutable receipts even
 * though its browser storage is unavailable. Every retry edge must be proved;
 * a sent UUID is never recycled for a new message with identical text.
 */
export function recoverGoogleVoiceDraft(
  scope: Scope,
  history: readonly TranslationReceipt[],
  dispatch: GoogleVoiceDispatchData['records'],
  known?: { id: string; requestId: string }
): RecoveredGoogleVoiceDraft | undefined {
  const canonical = scope.text.trim()
  const receipts = history.filter(row => row.owner === scope.owner && row.request?.accountId === scope.accountId && row.request?.conversationId === scope.conversationId && (row.requestId.startsWith('send-gv-') && !row.requestId.startsWith('send-gv-plain-') || row.requestId.startsWith('send-retry-')))
  const submitted = dispatch.filter(row => row.owner === scope.owner && row.windowId === scope.accountId && row.conversationId === scope.conversationId)
  const rawHashes = new Set([digest(scope.text), digest(canonical)])
  for (const row of submitted) {
    if (!['sent', 'not-sent', 'uncertain'].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 1) fail('incomplete')
    if (row.migratedTextHash !== undefined && !/^[a-f0-9]{64}$/.test(row.migratedTextHash)) fail('incomplete')
    if (row.state === 'uncertain' && (rawHashes.has(row.originalHash) || row.migratedTextHash === digest(canonical))) fail('uncertain')
    if (row.state !== 'sent' && !row.requestId.startsWith('send-gv-plain-') && rawHashes.has(row.originalHash) && !receipts.some(receipt => receipt.requestId === row.requestId)) fail('incomplete')
  }
  // This adds no tombstone row: only a genuinely migrated submission receives
  // a fingerprint on its existing dispatch record. Once explicitly sent, the
  // next equal-text intent is new, not another abandoned legacy draft.
  if (!known && submitted.some(row => row.state === 'sent' && row.migratedTextHash === digest(canonical))) return undefined
  const groups = new Map<string, TranslationReceipt[]>()
  for (const row of receipts) {
    const key = row.request.messageId || ''
    groups.set(key, [...(groups.get(key) || []), row])
  }
  const recovered: RecoveredGoogleVoiceDraft[] = []
  for (const [id, group] of groups) {
    if (known && id !== known.id) continue
    const attempts = submitted.filter(row => group.some(receipt => receipt.requestId === row.requestId))
    // An unrelated expired body provides no identity evidence. Never let a
    // cleaned history item disable every new message in this conversation.
    const matches = group.some(row => row.request.text?.trim() === canonical) || attempts.some(row => rawHashes.has(row.originalHash) || row.migratedTextHash === digest(canonical))
    if (!known && !matches) continue
    if (attempts.some(row => row.state === 'sent')) { if (known) fail('sent'); continue }
    if (attempts.some(row => row.state === 'uncertain')) fail('uncertain')
    if (group.some(row => row.contentExpired || row.contextCleared)) fail('expired')
    if (!uuid(id) || group.some(row => row.request.text?.trim() !== canonical || row.request.requestId !== row.requestId || !row.request.targetLanguage)) fail('incomplete')
    const byId = new Map(group.map(row => [row.requestId, row]))
    const roots = group.filter(row => rootId(row.requestId))
    if (byId.size !== group.length || roots.length !== 1 || group.some(row => !rootId(row.requestId) && !retryId(row.requestId))) fail(roots.length > 1 ? 'ambiguous' : 'incomplete')
    const original = roots[0].request
    if (group.some(row => row.request.targetLanguage !== original.targetLanguage || row.request.sourceLanguage !== original.sourceLanguage || qualityKey(row.request.quality) !== qualityKey(original.quality) || JSON.stringify(row.request.context || []) !== JSON.stringify(original.context || []))) fail('incomplete')
    const seen = new Set<string>()
    let leaf = roots[0]
    while (true) {
      if (seen.has(leaf.requestId)) fail('incomplete')
      seen.add(leaf.requestId)
      if (!leaf.retryRequestId) break
      if (leaf.state !== 'failed' || leaf.chargedCharacters !== 0 || leaf.retryRequestId !== 'send-retry-' + digest(leaf.requestId)) fail('incomplete')
      const next = byId.get(leaf.retryRequestId)
      if (!next) fail('incomplete')
      leaf = next
    }
    if (seen.size !== group.length || !['queued', 'pending', 'failed', 'charged', 'cached', 'free'].includes(leaf.state)) fail('incomplete')
    if (leaf.state === 'failed' && leaf.chargedCharacters !== 0) fail('incomplete')
    if (['charged', 'cached', 'free'].includes(leaf.state) && !(leaf.correction ?? leaf.translated)?.trim()) fail('incomplete')
    if (known) {
      const saved = byId.get(known.requestId)
      if (!saved) fail('incomplete')
      recovered.push({ id, requestId: saved.requestId, request: { ...saved.request } })
    } else recovered.push({ id, requestId: leaf.requestId, request: { ...leaf.request } })
  }
  if (recovered.length > 1) fail('ambiguous')
  if (known && recovered.length !== 1) fail('incomplete')
  return recovered[0]
}
