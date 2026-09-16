/** Explicit user order wins; existing pinned accounts keep their old order until a drag. */
export function orderedAccounts<T extends { id: string; pinned?: boolean; tabOrder?: number }>(accounts: T[]): T[] {
  return [...accounts].sort((a, b) => {
    const x = Number.isSafeInteger(a.tabOrder) && a.tabOrder! >= 0 ? a.tabOrder! : null
    const y = Number.isSafeInteger(b.tabOrder) && b.tabOrder! >= 0 ? b.tabOrder! : null
    if (x !== null || y !== null) return (x ?? Number.MAX_SAFE_INTEGER) - (y ?? Number.MAX_SAFE_INTEGER)
    return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
  })
}

export function moveAccount(ids: string[], source: string, target: string): string[] {
  const from = ids.indexOf(source), to = ids.indexOf(target)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1); next.splice(to, 0, source)
  return next
}
