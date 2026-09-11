import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AppSettings, RuntimeSettings } from '../types'

const defaults: AppSettings = {
  historyMode: 'new', previewSend: false, backTranslation: false,
  notifications: 'background', notificationSound: false, autoStart: false, startMinimized: false, closeToTray: false,
  localLanguage: 'zh-CN',
  targetLanguage: 'en-US',
  provider: 'openai',
  receiveAutoTranslate: true,
  sendAutoTranslate: true,
  blockChineseSend: true,
  groupTranslate: false,
  fontSize: 13,
  translationColor: '#c8d4e4',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna'
}

export class SettingsStore {
  private get path(): string {
    return join(app.getPath('userData'), 'settings.sec')
  }

  async get(): Promise<AppSettings> {
    const envMerged: AppSettings = {
      ...defaults,
      openaiApiKey: process.env.OPENAI_API_KEY || undefined,
      openaiModel: process.env.OPENAI_MODEL || defaults.openaiModel,
      deeplApiKey: process.env.DEEPL_API_KEY || undefined,
      googleApiKey: process.env.GOOGLE_TRANSLATE_API_KEY || undefined
    }

    try {
      const raw = await fs.readFile(this.path, 'utf8')
      let json: string
      if (raw.startsWith('enc:')) {
        json = safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
      } else if (raw.startsWith('plain:')) {
        json = Buffer.from(raw.slice(6), 'base64').toString('utf8')
      } else {
        return envMerged
      }
      return { ...envMerged, ...JSON.parse(json) }
    } catch {
      return envMerged
    }
  }

  async save(settings: AppSettings): Promise<void> {
    const json = JSON.stringify(settings)
    const raw = safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(json).toString('base64')}`
      : `plain:${Buffer.from(json, 'utf8').toString('base64')}`
    await fs.writeFile(this.path, raw, { encoding: 'utf8', mode: 0o600 })
  }

  async runtime(): Promise<RuntimeSettings> {
    const s = await this.get()
    return {
      historyMode: s.historyMode, previewSend: s.previewSend, backTranslation: s.backTranslation,
      localLanguage: s.localLanguage,
      targetLanguage: s.targetLanguage,
      provider: s.provider,
      receiveAutoTranslate: s.receiveAutoTranslate,
      sendAutoTranslate: s.sendAutoTranslate,
      blockChineseSend: s.blockChineseSend !== false,
      groupTranslate: s.groupTranslate === true,
      fontSize: Number(s.fontSize || 13),
      translationColor: s.translationColor || '#c8d4e4'
    }
  }
}
