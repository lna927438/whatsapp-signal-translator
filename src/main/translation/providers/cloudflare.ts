import { createHash, randomUUID } from 'crypto'
import type { TranslationRequest } from '../../types'
import type { TranslationProvider } from './provider'

const DEFAULT_API_BASE = 'https://realtime-translator-api.lna927438.workers.dev'

export class CloudflareProvider implements TranslationProvider {
  constructor(private readonly accessToken: string, private readonly apiBase = DEFAULT_API_BASE) {}

  async translate(request: TranslationRequest): Promise<string> {
    const token = this.accessToken.trim()
    if (!token) throw new Error('在线登录令牌缺失，请重新登录。')

    const body = {
      text: request.text.trim(),
      sourceLanguage: request.sourceLanguage || 'auto',
      targetLanguage: request.targetLanguage,
      accountId: request.accountId || '',
      conversationId: request.conversationId || '',
      context: request.context || []
    }
    // Message identities survive a renderer retry/restart. A fresh manual test
    // without a message ID is a new operation, unless its caller supplies an ID.
    const requestId = request.requestId || (request.messageId
      ? `message-${createHash('sha256').update(JSON.stringify([request.messageId, body])).digest('hex')}`
      : randomUUID())
    const encoded = JSON.stringify({ ...body, requestId })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let response: Response
      let payload: any
      try {
        response = await fetch(`${this.apiBase.replace(/\/$/, '')}/api/translate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-request-id': requestId
          },
          body: encoded,
          signal: AbortSignal.timeout(65_000)
        })
        payload = await response.json()
      } catch {
        if (attempt === 4) throw new Error('云端响应未确认，请稍后重试同一条消息。')
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
        continue
      }
      if (response.status === 202 || (response.status === 503 && payload?.error === 'settlement_pending')) {
        if (attempt === 4) throw new Error('翻译仍在处理中，请稍后重试同一条消息。')
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
        continue
      }
      if (!response.ok) {
        if (response.status === 401) throw new Error('在线登录状态已过期，请重新登录。')
        if (response.status === 403) throw new Error('账号已停用，无法使用在线翻译。')
        if (response.status === 402) throw new Error('可用字符余额不足，请等待正在处理的翻译完成或充值。')
        throw new Error(String(payload?.message || `云端翻译失败 (${response.status})`))
      }
      const translated = String(payload?.translation || '').trim()
      if (!translated) throw new Error('云端翻译返回为空。')
      return translated
    }
    throw new Error('云端响应未确认。')
  }
}
