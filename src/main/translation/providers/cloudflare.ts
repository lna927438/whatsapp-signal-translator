import { randomUUID } from 'crypto'
import type { TranslationRequest } from '../../types'
import type { TranslationProvider } from './provider'

const DEFAULT_API_BASE = 'https://realtime-translator-api.lna927438.workers.dev'

export class CloudflareProvider implements TranslationProvider {
  constructor(private readonly accessToken: string, private readonly apiBase = DEFAULT_API_BASE) {}

  async translate(request: TranslationRequest): Promise<string> {
    const token = this.accessToken.trim()
    if (!token) throw new Error('在线登录令牌缺失，请重新登录。')

    const response = await fetch(`${this.apiBase.replace(/\/$/, '')}/api/translate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-request-id': randomUUID()
      },
      body: JSON.stringify({
        text: request.text,
        sourceLanguage: request.sourceLanguage || 'auto',
        targetLanguage: request.targetLanguage,
        requestId: randomUUID(),
        accountId: request.accountId,
        conversationId: request.conversationId,
        context: request.context || []
      })
    })

    const payload: any = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status === 401) throw new Error('在线登录状态已过期，请重新登录。')
      if (response.status === 402) throw new Error(`字符余额不足。当前剩余 ${Number(payload?.balance || 0).toLocaleString()} 字符。`)
      throw new Error(String(payload?.message || `云端翻译失败 (${response.status})`))
    }

    const translated = String(payload?.translation || '').trim()
    if (!translated) throw new Error('云端翻译返回为空。')
    return translated
  }
}
