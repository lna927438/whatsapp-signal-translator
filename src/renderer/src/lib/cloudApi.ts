export function checkedWalletState(state: any) {
  for (const key of ['balance', 'lifetime_debited', 'lifetime_credited']) {
    const value = state?.wallet?.[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('云端字符数据未通过校验，请重新同步。')
  }
  return state
}

export const cloudApi = {
  me: async () => checkedWalletState(await window.desktopAPI.readCloud('/api/me')),
  wallet: () => window.desktopAPI.readCloud('/api/wallet'),
  usage: () => window.desktopAPI.readCloud('/api/usage')
}
