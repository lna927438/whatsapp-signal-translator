import { createHash } from 'node:crypto'

export interface GoogleVoiceMessageMedia {
  fingerprint: string
  count: number
  types: Array<'image/jpeg' | 'image/png' | 'image/gif' | 'image/bmp'>
  totalBytes: number
}

export interface GoogleVoiceRecipientContext { kind: 'recipients'; recipientKey: string; recipientCount: number }
export function googleVoiceRecipientContext(value: unknown): GoogleVoiceRecipientContext | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('收件人信息无效。')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['kind', 'recipientKey', 'recipientCount'].includes(key)) || raw.kind !== 'recipients' ||
    typeof raw.recipientKey !== 'string' || !/^[a-f0-9]{64}$/.test(raw.recipientKey) || !Number.isSafeInteger(raw.recipientCount) || Number(raw.recipientCount) < 1 || Number(raw.recipientCount) > 7) throw new Error('收件人信息无效。')
  return { kind: 'recipients', recipientKey: raw.recipientKey, recipientCount: Number(raw.recipientCount) }
}

/** Metadata only. Image bytes, filenames and browser URLs never cross this bridge. */
export function googleVoiceMessageMedia(value: unknown): GoogleVoiceMessageMedia | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片信息无效。')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['fingerprint', 'count', 'types', 'totalBytes'].includes(key)) ||
      typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint) ||
      !Number.isSafeInteger(raw.count) || Number(raw.count) < 1 || Number(raw.count) > 10 ||
      !Array.isArray(raw.types) || raw.types.length !== raw.count ||
      raw.types.some(type => !['image/jpeg', 'image/png', 'image/gif', 'image/bmp'].includes(type)) ||
      !Number.isSafeInteger(raw.totalBytes) || Number(raw.totalBytes) < 1 || Number(raw.totalBytes) > 20 * 1024 * 1024) throw new Error('图片信息无效。')
  return { fingerprint: raw.fingerprint, count: Number(raw.count), types: [...raw.types] as GoogleVoiceMessageMedia['types'], totalBytes: Number(raw.totalBytes) }
}

export function googleVoiceMediaKey(media: GoogleVoiceMessageMedia): string {
  return createHash('sha256').update(JSON.stringify([media.fingerprint, media.count, media.types, media.totalBytes])).digest('hex')
}
