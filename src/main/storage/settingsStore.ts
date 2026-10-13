import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AppSettings, RuntimeSettings } from '../types'
import { translationChannel } from '../../shared/translationChannels'
import { normalizeQuality } from '../../shared/translationPolicy'
import { normalizeUiPreference, resolveUiLanguage } from '../../shared/uiLocale'
const writes = new Map<string, Promise<void>>()
const retiredFields = ['openaiApiKey', 'openaiModel', 'deeplApiKey', 'googleApiKey'] as const
function cloudSettings(value: AppSettings): AppSettings {
  const result: any = { ...value, provider: 'openai', translationProvider: value.translationProvider === undefined ? 'deepseek' : translationChannel(value.translationProvider) }
  for (const key of retiredFields) delete result[key]
  delete result.providerPreference
  return result
}

const defaults: AppSettings = {
  workspaceTheme: 'charcoal',
  accountNavigationPosition: 'top',
  uiLanguage: 'system',
  historyMode: 'new', previewSend: false, backTranslation: false,
  notifications: 'background', notificationSound: false, autoStart: false, startMinimized: false, closeToTray: true, closeBehaviorVersion: 1,
  hideNotificationNames: true,
  localLanguage: 'zh-CN',
  targetLanguage: 'en-US',
  provider: 'openai',
  translationProvider: 'deepseek',
  receiveAutoTranslate: true,
  sendAutoTranslate: true,
  blockChineseSend: true,
  groupTranslate: false,
  fontSize: 13,
  translationColor: '#c8d4e4'
}

export class SettingsStore {
  private get secretPath(): string { return join(app.getPath('userData'), 'settings-keys.sec') }
  private async secretValues(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.secretPath, 'utf8')
      if (!raw.startsWith('enc:') || !safeStorage.isEncryptionAvailable()) throw new Error('encryption_unavailable')
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')))
    } catch (error: any) {
      if (error?.code === 'ENOENT') return {}
      throw new Error('无法解密服务密钥，请使用原 Windows 用户，原文件已保留。')
    }
  }

  async publicSettings(): Promise<AppSettings> {
    return this.get()
  }

  async migrateLegacySecrets(): Promise<void> {
    const value = await this.get()
    // Rewrite on startup so retired credentials are removed from both old
    // settings and the separate encrypted secret file, including empty keys.
    await this.save(value)
  }
  private get path(): string {
    return join(app.getPath('userData'), 'settings.sec')
  }

  async get(): Promise<AppSettings> {
    const envMerged = { ...defaults }

    try {
      const raw = await fs.readFile(this.path, 'utf8')
      let json: string
      if (raw.startsWith('enc:')) {
        json = safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
      } else if (raw.startsWith('plain:')) {
        json = Buffer.from(raw.slice(6), 'base64').toString('utf8')
      } else {
        throw new Error('invalid_settings_format')
      }
      const saved = JSON.parse(json)
      return cloudSettings({ ...envMerged, ...saved, ...(saved.closeBehaviorVersion === 1 ? {} : { closeToTray: true, closeBehaviorVersion: 1 }) })
    } catch (error: any) {
      if (error?.code === 'ENOENT') return cloudSettings(envMerged)
      throw new Error('无法读取安全设置，原文件已保留，请使用原 Windows 用户重试。')
    }
  }

  async save(settings: AppSettings): Promise<void> {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 65536) throw new Error('设置内容无效。')
    if (settings.accountNavigationPosition !== undefined && !['top','side'].includes(settings.accountNavigationPosition)) throw new Error('账号栏位置无效。')
    if (settings.workspaceTheme !== undefined && !['charcoal','soft'].includes(settings.workspaceTheme)) throw new Error('主题选项无效。')
    settings = { ...cloudSettings(settings), uiLanguage: normalizeUiPreference(settings.uiLanguage), translationQuality: normalizeQuality(settings.translationQuality) }
    if (settings.quickReplies && (!Array.isArray(settings.quickReplies) || settings.quickReplies.length > 30 || settings.quickReplies.some(item => typeof item !== 'string' || item.length > 2000))) throw new Error('快捷回复最多 30 条，每条最多 2000 字符。')
    await this.write(() => settings)
  }

  async setUiLanguage(value: unknown): Promise<void> {
    if (!['system', 'en', 'zh-CN'].includes(String(value))) throw new Error('Invalid interface language.')
    await this.write(async () => ({ ...await this.get(), uiLanguage: normalizeUiPreference(value) }))
  }

  private async write(update: () => AppSettings | Promise<AppSettings>): Promise<void> {
    const path = this.path
    const work = (writes.get(path) || Promise.resolve()).catch(() => undefined).then(async () => {
    const settings = cloudSettings(await update())
    await fs.mkdir(join(app.getPath('userData')), { recursive: true })
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密暂不可用，敏感设置尚未保存，原数据已保留。')
    const secrets = await this.secretValues()
    for (const key of retiredFields) delete secrets[key]
    const json = JSON.stringify(settings)
    const raw = `enc:${safeStorage.encryptString(json).toString('base64')}`
    await fs.writeFile(path + '.tmp', raw, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(path + '.tmp', path)
    // Remove only the retired credential file after preferences are safely saved.
    if (Object.keys(secrets).length) {
      await fs.writeFile(this.secretPath + '.tmp', 'enc:' + safeStorage.encryptString(JSON.stringify(secrets)).toString('base64'), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(this.secretPath + '.tmp', this.secretPath)
    } else {
      await fs.rm(this.secretPath, { force: true })
      await fs.rm(this.secretPath + '.tmp', { force: true })
    }
    })
    writes.set(path, work)
    await work
  }

  async runtime(): Promise<RuntimeSettings> {
    const s = await this.get()
    return {
      uiLanguage: resolveUiLanguage(s.uiLanguage, app.getLocale?.() || 'zh-CN'),
      translationQuality: s.translationQuality,
      historyMode: s.historyMode, previewSend: s.previewSend, backTranslation: s.backTranslation,
      localLanguage: s.localLanguage,
      targetLanguage: s.targetLanguage,
      provider: s.provider,
      translationProvider: s.translationProvider,
      receiveAutoTranslate: s.receiveAutoTranslate,
      sendAutoTranslate: s.sendAutoTranslate,
      blockChineseSend: s.blockChineseSend !== false,
      groupTranslate: s.groupTranslate === true,
      fontSize: Number(s.fontSize || 13),
      translationColor: s.translationColor || '#c8d4e4'
    }
  }
}
