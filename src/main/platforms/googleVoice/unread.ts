type Snapshot = { documentId: string; sequence: number; count: number | null }
type State = Snapshot & { retired: Set<string> }

/** Exact navigation snapshots only; never infer an inbox count from messages. */
export class GoogleVoiceUnread {
  private states = new Map<string, State>()
  observe(id: string, raw: unknown): { count: number | null; increased: boolean } | undefined {
    const value = raw as Partial<Snapshot> & { source?: unknown } | null
    if (!value || value.source !== 'sms-navigation' || typeof value.documentId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.documentId) ||
      !Number.isSafeInteger(value.sequence) || value.sequence! < 1 || value.sequence! > 0x7fffffff ||
      value.count !== null && (!Number.isSafeInteger(value.count) || value.count! < 0 || value.count! > 99999)) return
    const next = value as Snapshot, before = this.states.get(id)
    if (before?.retired.has(next.documentId) || before?.documentId === next.documentId && next.sequence <= before.sequence) return
    const newDocument = before?.documentId !== next.documentId
    const retired = before?.retired || new Set<string>()
    if (before && newDocument) { retired.add(before.documentId); if (retired.size > 32) retired.delete(retired.values().next().value!) }
    this.states.set(id, { ...next, retired })
    if (!newDocument && before?.count === next.count) return
    return { count: next.count, increased: !newDocument && before?.count !== null && before?.count !== undefined && next.count !== null && next.count > before.count }
  }
  clear(id?: string) { if (id) this.states.delete(id); else this.states.clear() }
}
