import { parseCharacterWallet } from '../../../shared/characterWallet'

export function checkedWalletState(state: any) {
  const wallet = parseCharacterWallet(state?.wallet)
  return Object.entries(wallet).every(([key, value]) => state.wallet[key] === value)
    ? state : { ...state, wallet: { ...state.wallet, ...wallet } }
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
