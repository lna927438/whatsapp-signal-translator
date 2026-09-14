/** Signal CLI's public JSON-RPC contract. See docs/product/signal-beta-3.md. */
export function normalizeSignalPeer(value: string): string {
  const peer = String(value || '').trim()
  if (/^group:[A-Za-z0-9+/]+={0,2}$/.test(peer)) return peer
  if (/^(?:aci:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(peer)) return peer.replace(/^aci:/i, '').toLowerCase()
  if (/^u:[a-z0-9_]{3,32}\.\d{2,}$/i.test(peer)) return peer
  if (/^@?[a-z0-9_]{3,32}\.\d{2,}$/i.test(peer)) return 'u:' + peer.replace(/^@/, '')
  const number = peer.replace(/[\s().-]/g, '')
  if (/^\+[1-9]\d{5,14}$/.test(number)) return number
  throw new Error('请输入带国家区号的手机号（例如 +1…）或完整 Signal 用户名。')
}

export function signalSendParameters(account: string, peer: string, message: string) {
  const recipient = normalizeSignalPeer(peer)
  return recipient.startsWith('group:')
    ? { account, groupId: recipient.slice(6), message }
    : { account, recipient: [recipient], message }
}

export interface SignalContact {
  id: string
  name: string
  kind: 'contact' | 'group'
  number?: string
  aliases: string[]
  username?: string
  about?: string
  profileName?: string
  givenName?: string
  familyName?: string
  nickName?: string
  note?: string
  archived?: boolean
  blocked?: boolean
  expiration?: number
  hasAvatar?: boolean
  members?: Array<{ id: string; name: string; isAdmin: boolean }>
  description?: string
  groupInviteLink?: string
  isMember?: boolean
  permissionAddMember?: string
  permissionEditDetails?: string
}

export function signalContacts(contacts: any[], groups: any[] = []): SignalContact[] {
  const result: SignalContact[] = []
  for (const item of contacts) {
    if (item.isHidden || item.unregistered) continue
    const aliases = [item.number, item.uuid, item.username ? 'u:' + item.username : ''].filter(Boolean)
    if (!aliases.length) continue
    const profileName = [item.profile?.givenName, item.profile?.familyName].filter(Boolean).join(' ')
    result.push({ id: aliases[0], aliases, name: item.nickName || item.name || profileName || item.username || aliases[0], number: item.number || undefined, kind: 'contact',
      username: item.username || undefined, profileName, givenName: item.profile?.givenName || '', familyName: item.profile?.familyName || '',
      about: [item.profile?.aboutEmoji, item.profile?.about].filter(Boolean).join(' '), nickName: item.nickName || '', note: item.note || '',
      archived: item.isArchived === true, blocked: item.isBlocked === true, expiration: Number(item.messageExpirationTime) || 0, hasAvatar: item.profile?.hasAvatar === true })
  }
  for (const item of groups) {
    if (!item.id || item.isMember === false) continue
    const id = 'group:' + item.id
    result.push({ id, aliases: [id], name: item.name || 'Signal 群组', kind: 'group', blocked: item.isBlocked === true, isMember: item.isMember,
      description: item.description || '', expiration: Number(item.messageExpirationTime) || 0, groupInviteLink: item.groupInviteLink || undefined,
      permissionAddMember: item.permissionAddMember, permissionEditDetails: item.permissionEditDetails,
      members: (item.members || []).map((member: any) => {
        const peer = member.number || member.uuid
        return { id: peer, name: result.find(contact => contact.aliases.includes(peer))?.name || peer, isAdmin: member.isAdmin === true }
      }).filter((member: any) => member.id) })
  }
  return result
}

export function signalEnvelopePeer(envelope: any): string {
  const data = envelope.syncMessage?.sentMessage || envelope.dataMessage
  if (data?.groupInfo?.groupId) return 'group:' + data.groupInfo.groupId
  const peer = envelope.syncMessage?.sentMessage
    ? data.destinationNumber || data.destinationUuid || data.destination
    : envelope.sourceNumber || envelope.sourceUuid || envelope.source
  return typeof peer === 'string' ? peer.replace(/^aci:/, '') : ''
}

export function signalSendTimestamp(result: any): number {
  if (!Number.isSafeInteger(result?.timestamp) || result.timestamp <= 0) throw new Error('Signal 尚未返回发送结果，请在记录与恢复中处理。')
  if (Array.isArray(result.results) && result.results.some((item: any) => item.type !== 'SUCCESS')) throw new Error('Signal 返回了未完成的发送结果，请在记录与恢复中处理。')
  return result.timestamp
}
