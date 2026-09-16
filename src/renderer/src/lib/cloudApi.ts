export function checkedWalletState(state: any) {
  for (const key of ['balance', 'lifetime_debited', 'lifetime_credited']) {
    const value = state?.wallet?.[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('云端字符数据未通过校验，请重新同步。')
  }
  const adjusted = state?.wallet?.lifetime_adjusted_down
  if (adjusted !== undefined && (!Number.isSafeInteger(adjusted) || adjusted < 0)) throw new Error('云端字符数据未通过校验，请重新同步。')
  return state
}

export const cloudApi = {
  snapshot: async () => {
    const value = checkedWalletState(await window.desktopAPI.readCloud('/api/account-snapshot'))
    if (!Array.isArray(value.usage) || !Array.isArray(value.ledger) || !Number.isFinite(Date.parse(value.snapshotAt))) throw new Error('对账快照未通过校验。')
    for (const key of ['translationDebit', 'usageCharacters', 'duplicateDebits', 'mismatchedRequests']) if (!Number.isSafeInteger(value.reconciliation?.[key]) || value.reconciliation[key] < 0) throw new Error('对账汇总未通过校验。')
    for (const item of value.usage) if (typeof item.request_id !== 'string' || !Number.isSafeInteger(item.source_characters) || item.source_characters < 1) throw new Error('使用记录未通过校验。')
    for (const item of value.ledger) if (!Number.isSafeInteger(item.characters) || !Number.isSafeInteger(item.balance_after) || item.balance_after < 0) throw new Error('账本未通过校验。')
    return value
  },
  me: async () => checkedWalletState(await window.desktopAPI.readCloud('/api/me')),
  wallet: () => window.desktopAPI.readCloud('/api/wallet'),
  usage: () => window.desktopAPI.readCloud('/api/usage')
}
