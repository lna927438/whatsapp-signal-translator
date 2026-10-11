/** Official Web A routes: peer[_thread][_thread|pinned|scheduled]. Never use a display name as identity. */
export function telegramConversation(hash: string): { id: string; peer: string; route: string; writable: boolean; group: boolean } | undefined {
  const route = hash.replace(/^#/, '').split('?')[0]
  const parts = route.split('_')
  if (!/^-?\d+$/.test(parts[0]) || parts.length > 3 || parts.slice(1).some(part => !/^(?:-?\d+|thread|pinned|scheduled)$/.test(part))) return undefined
  const thread = parts[1] && /^-?\d+$/.test(parts[1]) ? parts[1] : '0'
  return { id: `telegram:${parts[0]}:${thread}`, peer: parts[0], route, writable: !parts.some(part => ['pinned','scheduled'].includes(part)), group: parts[0].startsWith('-') }
}

/** Server IDs must be positive integers. Telegram's optimistic IDs cannot prove delivery. */
export function telegramMessageId(value: string | null): string | undefined {
  return value && /^[1-9]\d{0,19}$/.test(value) ? value : undefined
}
