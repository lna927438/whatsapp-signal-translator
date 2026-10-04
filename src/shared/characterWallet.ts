export interface CharacterWallet {
  balance: number
  lifetime_credited: number
  lifetime_debited: number
  lifetime_adjusted_down?: number
}

/** PostgreSQL bigint values may arrive as decimal strings. Missing or corrupt
 * counters are unknown data, never a confirmed zero-character balance. */
export function parseCharacterWallet(value: unknown): CharacterWallet {
  const invalid = () => new Error('云端字符数据未通过校验，请重新同步。')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const wallet = value as Record<string, unknown>
  const counter = (input: unknown): number => {
    if (typeof input !== 'number' && (typeof input !== 'string' || !/^\d+$/.test(input))) throw invalid()
    const parsed = typeof input === 'number' ? input : Number(input)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid()
    return parsed
  }
  return {
    balance: counter(wallet.balance),
    lifetime_credited: counter(wallet.lifetime_credited),
    lifetime_debited: counter(wallet.lifetime_debited),
    ...(wallet.lifetime_adjusted_down !== undefined ? { lifetime_adjusted_down: counter(wallet.lifetime_adjusted_down) } : {})
  }
}
