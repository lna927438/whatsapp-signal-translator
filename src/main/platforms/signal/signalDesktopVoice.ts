import { validateVoiceWav, VOICE_MAX_BYTES } from '../../../shared/voiceAudio'

export type DesktopVoiceRequest = { id: string; conversationId: string; attachmentId: string; bytes: Uint8Array; expiresAt?: number }
export type DesktopVoiceResult = { text: string; translation: string; audioId: string; targetLanguage: 'zh-CN' }

export function decodeSignalVoiceRequest(raw: unknown): DesktopVoiceRequest {
  const value = raw as Record<string, unknown> | undefined
  if (!value || typeof value.id !== 'string' || !/^[\w-]{1,100}$/.test(value.id)
    || typeof value.conversationId !== 'string' || !/^[\w-]{1,100}$/.test(value.conversationId)
    || typeof value.attachmentId !== 'string' || !/^[a-f0-9]{64}$/.test(value.attachmentId)
    || typeof value.audioBase64 !== 'string' || value.audioBase64.length > Math.ceil(VOICE_MAX_BYTES / 3) * 4
    || (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now()))) throw new Error('invalid voice request')
  const decoded = Buffer.from(value.audioBase64, 'base64')
  if (decoded.toString('base64') !== value.audioBase64) throw new Error('invalid voice encoding')
  return { id: value.id, conversationId: value.conversationId, attachmentId: value.attachmentId,
    bytes: validateVoiceWav(new Uint8Array(decoded)), ...(value.expiresAt !== undefined ? { expiresAt: Number(value.expiresAt) } : {}) }
}
