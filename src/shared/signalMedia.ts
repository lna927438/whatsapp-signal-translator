export interface SignalAttachment {
  id: string
  filename: string
  contentType: string
  size: number
  width?: number
  height?: number
  isVoiceNote?: boolean
}
export interface SignalPayload { attachments: string[]; voiceNote?: boolean }
export interface SignalMediaEntry extends SignalAttachment { peer: string; timestamp: number; key: string }
export type SignalMediaAction = 'copy' | 'save' | 'menu'
export interface SignalMediaActionResult { action: 'copy' | 'save' | 'cancelled'; success: boolean }
export const SIGNAL_FILE_LIMIT = 100 * 1024 * 1024
export const SIGNAL_FILE_COUNT = 16
export function hasSignalMedia(payload?: SignalPayload): boolean { return Boolean(payload?.attachments?.length) }
export function mediaIntent(payload?: SignalPayload): string {
  return payload ? JSON.stringify([payload.attachments, payload.voiceNote === true]) : ''
}
export function signalNeedsTranslation(text: string): boolean {
  // Emoji, punctuation, and numbers carry no translatable prose.
  return /\p{L}/u.test(text)
}
export function mediaKind(mime: string): 'image' | 'video' | 'audio' | 'file' {
  mime = String(mime || '').split(';')[0].trim().toLowerCase()
  if (/^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) return 'image'
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(mime)) return 'video'
  if (/^audio\/(mpeg|mp4|aac|ogg|webm|wav|x-wav|flac)$/.test(mime)) return 'audio'
  return 'file'
}
export function signalAttachmentFilename(attachment: Pick<SignalAttachment, 'filename' | 'contentType'>): string {
  const extensions: Record<string, string> = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif', 'image/avif':'avif', 'video/mp4':'mp4', 'video/quicktime':'mov', 'video/webm':'webm', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/ogg':'ogg', 'audio/webm':'webm', 'audio/wav':'wav', 'application/pdf':'pdf', 'text/plain':'txt' }
  let name = String(attachment.filename || 'Signal').split(/[\\/]/).pop()!.replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').slice(-150) || 'Signal'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'Signal-' + name
  const extension = extensions[String(attachment.contentType || '').split(';')[0].trim().toLowerCase()]
  if (extension && !/\.[a-z0-9]{1,10}$/i.test(name)) name += '.' + extension
  return name
}
export function signalMediaEntries(messages: Array<{ peer: string; timestamp: number; attachments?: SignalAttachment[]; expired?: boolean; expiresAt?: number }>, now = Date.now()): SignalMediaEntry[] {
  const entries = new Map<string, SignalMediaEntry>()
  for (const message of messages) {
    if (message.expired || message.expiresAt && message.expiresAt <= now) continue
    for (const attachment of normalizeAttachments(message.attachments)) {
      const key = JSON.stringify([message.peer, message.timestamp, attachment.id])
      entries.set(key, { ...attachment, filename: signalAttachmentFilename(attachment), peer: message.peer, timestamp: message.timestamp, key })
    }
  }
  return [...entries.values()].sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key))
}
export function fileContentType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() || ''
  return ({ jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', avif:'image/avif', mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', opus:'audio/ogg', wav:'audio/wav', flac:'audio/flac', pdf:'application/pdf', txt:'text/plain' } as Record<string,string>)[extension] || 'application/octet-stream'
}
export function normalizeAttachments(value: unknown): SignalAttachment[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && typeof item.id === 'string' && /^[A-Za-z0-9_.-]{1,250}$/.test(item.id) && item.id !== '.' && item.id !== '..').map(item => ({
    id: item.id, filename: signalAttachmentFilename({ filename: String(item.filename || 'Signal'), contentType: String(item.contentType || 'application/octet-stream') }), contentType: String(item.contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase(),
    size: Math.max(0, Number(item.size) || 0), width: Number(item.width) || undefined, height: Number(item.height) || undefined, isVoiceNote: item.isVoiceNote === true
  }))
}
export function byteRange(header: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null
  return { start, end, partial: true }
}
