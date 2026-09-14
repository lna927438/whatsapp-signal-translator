import type { TranslationRequest } from '../types'
import { alreadyInTargetLanguage } from './outgoingPolicy'

export function needsOutgoingCredit(request: TranslationRequest, translate: boolean): boolean {
  return translate && /\p{L}/u.test(request.text) && !alreadyInTargetLanguage(request)
}

/** A cached/free translation still needs an active character balance for a new send. */
export class OutgoingCredit {
  private generation = 0
  private snapshot?: { owner: string; expires: number; settled: boolean; work: Promise<any> }
  constructor(private currentOwner: () => string, private read: () => Promise<any>,
    private settled: (id: string) => Promise<any>, private now = Date.now) {}
  invalidate() { this.generation++; this.snapshot = undefined }
  async check(owner: string, request: TranslationRequest, translate: boolean, fresh = false): Promise<void> {
    if (!needsOutgoingCredit(request, translate)) return
    if (!owner || this.currentOwner() !== owner) throw new Error('登录状态已变化，消息未发送。')
    const generation = this.generation
    if (!this.snapshot || this.snapshot.owner !== owner || this.snapshot.expires <= this.now() || fresh && this.snapshot.settled) {
      const entry = { owner, expires: this.now() + 2000, settled: false, work: this.read() }
      this.snapshot = entry
      void entry.work.then(() => { entry.settled = true }, () => { if (this.snapshot === entry) this.snapshot = undefined })
    }
    const state = await this.snapshot.work
    if (this.currentOwner() !== owner) throw new Error('登录状态已变化，消息未发送。')
    if (generation !== this.generation) return this.check(owner, request, translate)
    if (state?.user?.id !== owner || state?.profile?.status !== 'active') throw new Error('账号状态不可用，消息未发送。')
    const balance = state?.wallet?.balance, reserved = state?.wallet?.reserved_characters ?? 0
    if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isSafeInteger(reserved) || reserved < 0) throw new Error('字符余额尚未核实，消息未发送。请恢复连接后重试。')
    if (balance - reserved > 0) return
    // Spending the final characters on this exact request must not strand its paid result.
    if (request.requestId?.startsWith('send-')) {
      const receipt = await this.settled(request.requestId)
      if (this.currentOwner() !== owner) throw new Error('登录状态已变化，消息未发送。')
      if (receipt?.state === 'completed' && receipt.response?.requestId === request.requestId
        && receipt.response?.sourceCharacters === Array.from(request.text.trim()).length
        && typeof receipt.response.translation === 'string' && receipt.response.translation.trim()) return
    }
    throw new Error('可用字符已用完，无法发送翻译消息。请补充字符后重试，草稿已保留。')
  }
}
