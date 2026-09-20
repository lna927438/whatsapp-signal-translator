import { createHash, randomUUID } from 'crypto'

type Page = { authorized: () => boolean }
type Baseline = { token: string; conversationId: string; startedAt: number; expiresAt: number; anchorId: string; seen: Set<string>; page: Page }
const permissions = new WeakMap<object, () => boolean>()
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const current = (page: Page) => { try { return page.authorized() } catch { return false } }
const hashUuid = (value: string) => `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`

/** Only the verified English accessibility timestamp is currently understood.
 * Never guess relative dates, missing years, localized dates or Date.parse's
 * implementation-dependent formats. Minute precision cannot prove that an SMS
 * in the baseline's minute is new, so that boundary stays manual.
 */
export function googleVoiceMessageTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  const match = value.match(/,\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s*(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}) (20\d{2}),\s*(\d{1,2}):(\d{2}) (AM|PM)\.\s*$/)
  if (!match) return undefined
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(match[2])
  const day = Number(match[3]), year = Number(match[4]), hour12 = Number(match[5]), minute = Number(match[6])
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined
  const hour = hour12 % 12 + (match[7] === 'PM' ? 12 : 0), date = new Date(year, month, day, hour, minute)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || weekdays[date.getDay()] !== match[1]) return undefined
  return date.getTime()
}

/** This capability exists only in main memory, never in IPC/JSON. A renderer
 * supplying new=true or copying another page's proof cannot enable billing.
 */
export function isVerifiedGoogleVoiceIncoming(payload: object): boolean {
  return permissions.get(payload)?.() === true
}

export class GoogleVoiceIncomingHistory {
  private readonly baselines = new Map<string, Baseline>()
  constructor(private readonly now: () => number = Date.now) {}

  begin(scope: string, conversationId: string, value: unknown, page: Page): { token: string; startedAt: number; expiresAt: number; anchorId: string } {
    if (!Array.isArray(value) || value.length < 1 || value.length > 500 || !Array.from(value).every(uuid) || !current(page)) throw new Error('Invalid incoming baseline')
    const at = this.now()
    for (const [key, row] of this.baselines) if (!current(row.page) || row.expiresAt <= at) this.baselines.delete(key)
    if (!this.baselines.has(scope) && this.baselines.size >= 256) throw new Error('Incoming baseline capacity reached')
    const row: Baseline = { token: randomUUID(), conversationId, startedAt: at, expiresAt: at + 4 * 60 * 60 * 1000, anchorId: value[value.length - 1], seen: new Set(value), page }
    this.baselines.set(scope, row)
    return { token: row.token, startedAt: at, expiresAt: row.expiresAt, anchorId: row.anchorId }
  }

  attest(scope: string, payload: Record<string, unknown>, proof: unknown, page: Page): void {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return
    const value = proof as Record<string, unknown>, row = this.baselines.get(scope), now = this.now()
    if (!row || !current(page) || !current(row.page) || row.expiresAt <= now || row.token !== value.token || row.anchorId !== value.anchorId || row.conversationId !== payload.conversationId || row.seen.size >= 1000 || !uuid(payload.id) || row.seen.has(payload.id) || value.messageDirection !== 'incoming') return
    const at = googleVoiceMessageTime(value.timestamp)
    if (at === undefined || at <= row.startedAt || at > now) return
    const id = hashUuid(createHash('sha256').update(JSON.stringify([payload.conversationId, value.messageDirection, value.timestamp, payload.text])).digest('hex'))
    if (id !== payload.id) return
    // Reserve once even if a provider fails or its UI receipt is lost. Recovery
    // uses the ordinary manual action and the unchanged durable request ID.
    row.seen.add(id)
    permissions.set(payload, () => this.baselines.get(scope) === row && current(row.page) && current(page) && this.now() < row.expiresAt)
  }
}
