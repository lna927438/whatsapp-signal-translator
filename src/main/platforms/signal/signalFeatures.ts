import { ipcMain, dialog, nativeImage, app, clipboard, ClipboardItem, Menu } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile, stat, copyFile } from 'fs/promises'
import { basename, join } from 'path'
import { AccountManager } from '../../accounts/accountManager'
import { SignalAdapter } from './signalAdapter'
import { normalizeSignalPeer, signalContacts } from '../../../shared/signalProtocol'
import { signalDataDirectory } from './signalCli'
import { grantSignalMedia } from './signalMediaProtocol'
import { SIGNAL_FILE_COUNT, SIGNAL_FILE_LIMIT, mediaKind, signalAttachmentFilename, type SignalAttachment, type SignalMediaAction, type SignalMediaActionResult } from '../../../shared/signalMedia'
import { mainFrame } from '../../securityPolicy'
import { t } from '../../uiLocale'

const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || value.length > max) throw new Error('内容过长或格式无效。')
  return value.trim()
}
const directPeer = (value: string) => { const peer = normalizeSignalPeer(value); if (peer.startsWith('group:')) throw new Error('请选择联系人。'); return peer }
const expiry = (value: unknown) => { if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2419200) throw new Error('限时消息时长无效。'); return value }

/** Only this main-window API can mutate Signal settings. The renderer never gets
 * an arbitrary JSON-RPC, filesystem path, account secret, or identity trust API. */
export function registerSignalFeatures(window: BrowserWindow, signal: SignalAdapter, owner: () => string) {
  const accounts = new AccountManager()
  const handle = (channel: string, run: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>) => ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender.id !== window.webContents.id || !mainFrame(event)) throw new Error('此操作只能从主窗口执行。')
    const user = owner(), result = await run(event, ...args)
    if (user !== owner()) throw new Error('登录状态已变化。')
    return result
  })
  const context = async (event: IpcMainInvokeEvent, id: string) => {
    if (event.sender.id !== window.webContents.id || !mainFrame(event)) throw new Error('此操作只能从主窗口执行。')
    const user = owner(), record = (await accounts.list()).find(item => item.id === id && item.platform === 'signal')
    if (!record?.signalAccount || user !== owner()) throw new Error('Signal 账号不可用。')
    return { user, record, account: record.signalAccount }
  }
  const request = async (c: Awaited<ReturnType<typeof context>>, method: string, params: Record<string, unknown> = {}) => {
    const current = (await accounts.list()).find(item => item.id === c.record.id)
    if (c.user !== owner() || current?.signalAccount !== c.account) throw new Error('Signal 账号已切换。')
    return signal.request(c.account, method, params)
  }
  const changed = (id: string) => { if (!window.isDestroyed()) window.webContents.send('signal:changed', { accountId: id }) }
  const avatarCache = new Map<string, { value: string; expires: number }>()
  const avatar = async (account: string, peer: string) => {
    const key = owner() + ':' + account + ':' + peer, cached = avatarCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    let value = ''
    try {
      const result = await signal.request(account, 'getAvatar', peer.startsWith('group:') ? { groupId: peer.slice(6) } : { profile: peer })
      if (typeof result?.data === 'string' && result.data.length <= 8 * 1024 * 1024) {
        const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
        if (!image.isEmpty()) value = image.resize({ width: 192 }).toDataURL()
      }
    } catch {}
    if (avatarCache.size > 300) avatarCache.clear()
    avatarCache.set(key, { value, expires: Date.now() + 5 * 60000 }); return value
  }
  handle('signal:preferences-get', async (event, id: string) => { const c = await context(event, id); return signal.preferences.get(c.user, c.account) })
  handle('signal:preferences-save', async (event, id: string, patch: unknown) => { const c = await context(event, id); const value = await signal.preferences.save(c.user, c.account, patch); changed(id); return value })
  handle('signal:conversation-preferences', async (event, id: string, peer: string, patch: unknown) => { const c = await context(event, id); const value = await signal.preferences.conversation(c.user, c.account, peer, patch); changed(id); return value })
  handle('signal:folder', async (event, id: string, value: any) => { const c = await context(event, id); const next = await signal.preferences.folder(c.user, c.account, value); changed(id); return next })
  handle('signal:mark-read', async (event, id: string, peer: string) => { const c = await context(event, id); return signal.markRead(c.account, normalizeSignalPeer(peer)) })
  handle('signal:avatar', async (event, id: string, peer: string) => { const c = await context(event, id); return avatar(c.account, normalizeSignalPeer(peer)) })
  handle('signal:profile', async (event, id: string) => {
    const c = await context(event, id)
    const rows = await request(c, 'listContacts', { recipient: [c.account], allRecipients: true })
    const profile = signalContacts(Array.isArray(rows) ? rows : []).find(item => item.aliases.includes(c.account))
    return { ...profile, id: c.account, number: c.account, name: profile?.profileName || profile?.name || c.account, about: (rows || []).find((item: any) => item.number === c.account)?.profile?.about || '', avatar: '' }
  })
  handle('signal:profile-save', async (event, id: string, value: any) => {
    const c = await context(event, id)
    const params: Record<string, unknown> = { givenName: text(value.givenName, 64), familyName: text(value.familyName || '', 64), about: text(value.about || '', 140) }
    if (!params.givenName) throw new Error('请输入名字。')
    await request(c, 'updateProfile', params); changed(id); return true
  })
  handle('signal:profile-photo', async (event, id: string) => {
    const c = await context(event, id)
    const choice = await dialog.showOpenDialog(window, { title: '选择 Signal 头像', filters: [{ name: '图片', extensions: ['jpg','jpeg','png','webp'] }], properties: ['openFile'] })
    if (choice.canceled || !choice.filePaths[0]) return false
    if (c.user !== owner()) throw new Error('登录状态已变化。')
    if ((await stat(choice.filePaths[0])).size > 10 * 1024 * 1024) throw new Error('请选择小于 10 MB 的图片。')
    const photo = nativeImage.createFromPath(choice.filePaths[0])
    if (photo.isEmpty()) throw new Error('图片无法读取。')
    const path = join(app.getPath('temp'), `hellodog-signal-avatar-${Date.now()}.png`)
    await writeFile(path, photo.resize({ width: 512 }).toPNG())
    try { await request(c, 'updateProfile', { avatar: path }); avatarCache.clear(); changed(id); return true }
    finally { await import('fs/promises').then(fs => fs.unlink(path)).catch(() => undefined) }
  })
  handle('signal:details', async (event, id: string, value: string) => {
    const c = await context(event, id), peer = normalizeSignalPeer(value)
    const contacts = await signal.listContacts(c.account)
    let contact = contacts.find(item => item.id === peer || item.aliases.includes(peer))
    if (!contact && !peer.startsWith('group:')) {
      const rows = await request(c, 'listContacts', { recipient: [peer], allRecipients: true })
      contact = signalContacts(Array.isArray(rows) ? rows : [])[0]
    }
    const details = contact || { id: peer, aliases: [peer], kind: peer.startsWith('group:') ? 'group' : 'contact', name: peer }
    const sharedGroups = details.kind === 'group' ? [] : contacts.filter(item => item.kind === 'group' && item.members?.some((member: any) => details.aliases.includes(member.id)))
    return { ...details, avatar: '', sharedGroups }
  })
  handle('signal:contact-save', async (event, id: string, value: string, patch: any) => {
    const c = await context(event, id), peer = directPeer(value), params: Record<string, unknown> = { recipient: peer }
    if (patch.nickName !== undefined) { params.nickGivenName = text(patch.nickName, 80); params.nickFamilyName = '' }
    if (patch.note !== undefined) params.note = text(patch.note, 2000)
    if (patch.expiration !== undefined) params.expiration = expiry(patch.expiration)
    await request(c, 'updateContact', params); changed(id); return true
  })
  handle('signal:block', async (event, id: string, value: string, blocked: boolean) => {
    const c = await context(event, id), peer = normalizeSignalPeer(value)
    if (typeof blocked !== 'boolean') throw new Error('屏蔽操作无效。')
    if (peer === c.account) throw new Error('不能屏蔽备忘录。')
    await request(c, blocked ? 'block' : 'unblock', peer.startsWith('group:') ? { groupId: [peer.slice(6)] } : { recipient: [peer] })
    changed(id); return true
  })
  handle('signal:safety', async (event, id: string, peer: string) => { const c = await context(event, id); return request(c, 'listIdentities', { number: directPeer(peer) }) })
  handle('signal:safety-verify', async (event, id: string, peer: string, safetyNumber: string) => {
    const c = await context(event, id), number = String(safetyNumber || '').replace(/\s/g, '')
    if (!/^\d{60}$/.test(number)) throw new Error('安全码格式无效。')
    await request(c, 'trust', { recipient: directPeer(peer), verifiedSafetyNumber: number }); return true
  })
  handle('signal:group-save', async (event, id: string, peer: string | null, value: any) => {
    const c = await context(event, id), params: Record<string, unknown> = {}
    if (peer) { const group = normalizeSignalPeer(peer); if (!group.startsWith('group:')) throw new Error('请选择群组。'); params.groupId = group.slice(6) }
    if (value.name !== undefined) params.name = text(value.name, 100)
    if (value.description !== undefined) params.description = text(value.description, 1000)
    if (value.expiration !== undefined) params.expiration = expiry(value.expiration)
    if (value.members !== undefined) { if (!Array.isArray(value.members) || value.members.length > 100) throw new Error('群成员过多。'); params.member = [...new Set(value.members.map(directPeer))] }
    if (!peer && (!params.name || !(params.member as string[])?.length)) throw new Error('请输入群名并选择成员。')
    const result = await request(c, 'updateGroup', params); changed(id); return result
  })
  handle('signal:group-quit', async (event, id: string, value: string) => {
    const c = await context(event, id), peer = normalizeSignalPeer(value)
    if (!peer.startsWith('group:')) throw new Error('请选择群组。')
    await request(c, 'quitGroup', { groupId: peer.slice(6) }); changed(id); return true
  })
  handle('signal:devices', async (event, id: string) => { const c = await context(event, id); return request(c, 'listDevices') })
  handle('signal:media-pick', async (event, id: string) => {
    const c = await context(event, id), selection = await dialog.showOpenDialog(window, { title: '选择图片、视频或文件', properties: ['openFile','multiSelections'] })
    if (selection.canceled) return []
    if (selection.filePaths.length > SIGNAL_FILE_COUNT) throw new Error('每次最多选择 16 个文件。')
    const result: SignalAttachment[] = []
    for (const path of selection.filePaths) { if (owner() !== c.user) throw new Error('登录状态已变化。'); result.push(await signal.media.stage(c.user, id, { path, filename: basename(path) })) }
    return result
  })
  handle('signal:media-stage', async (event, id: string, value: any) => {
    const c = await context(event, id)
    if (!(value?.bytes instanceof Uint8Array) || value.bytes.byteLength > SIGNAL_FILE_LIMIT || typeof value.filename !== 'string') throw new Error('附件格式或大小无效。')
    return signal.media.stage(c.user, id, { bytes: value.bytes, filename: value.filename, voiceNote: value.voiceNote === true })
  })
  handle('signal:media-staged', async (event, id: string, ids: string[]) => {
    const c = await context(event, id)
    if (!Array.isArray(ids) || ids.length > SIGNAL_FILE_COUNT) throw new Error('附件列表无效。')
    return Promise.all(ids.map(async key => (await signal.media.get(c.user, id, key)).attachment))
  })
  const mediaFile = async (event: IpcMainInvokeEvent, id: string, peer: string, attachmentId: string, staged = false) => {
    const c = await context(event, id), target = staged ? '' : normalizeSignalPeer(peer)
    const historyAttachment = async () => (await signal.loadHistory(c.account)).filter(item => item.peer === target).flatMap(item => item.attachments || []).find(item => item.id === attachmentId)
    const attachment = staged ? (await signal.media.get(c.user, id, attachmentId)).attachment : await historyAttachment()
    if (!attachment) throw new Error('此对话中没有该附件，可能已过期。')
    const path = await signal.media.received(c.user, id, attachment, join(signalDataDirectory(), 'attachments'), async () => {
      const result = await request(c, 'getAttachment', { id: attachment.id, ...(target.startsWith('group:') ? { groupId: target.slice(6) } : { recipient: target }) })
      if (typeof result?.data !== 'string' || result.data.length > 140 * 1024 * 1024) throw new Error('附件内容暂时不可用。')
      return Buffer.from(result.data, 'base64')
    })
    const allowed = async () => {
      if (window.isDestroyed() || c.user !== owner()) return false
      const current = (await accounts.list()).find(item => item.id === id)
      if (current?.signalAccount !== c.account) return false
      return staged ? Boolean(await signal.media.get(c.user, id, attachmentId).catch(() => undefined)) : Boolean(await historyAttachment())
    }
    if (!await allowed()) throw new Error('附件已过期或账号已切换。')
    return { c, attachment, path, allowed }
  }
  handle('signal:media-url', async (event, id: string, peer: string, attachmentId: string, staged = false) => {
    const file = await mediaFile(event, id, peer, attachmentId, staged)
    return grantSignalMedia(file.path, file.attachment.contentType, file.allowed)
  })
  const mediaAction = async (event: IpcMainInvokeEvent, id: string, peer: string, attachmentId: string, action: 'save' | 'copy'): Promise<SignalMediaActionResult> => {
    const { c, attachment, path, allowed } = await mediaFile(event, id, peer, attachmentId)
    if (action === 'copy') {
      if (mediaKind(attachment.contentType) !== 'image') throw new Error('此附件不是图片，请保存后查看。')
      if ((await stat(path)).size > SIGNAL_FILE_LIMIT) throw new Error('图片过大，请保存后查看。')
      const bytes = await readFile(path)
      if (bytes.byteLength > SIGNAL_FILE_LIMIT) throw new Error('图片过大，请保存后查看。')
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) throw new Error('此图片格式暂不支持复制，请先保存。')
      if (c.user !== owner() || !await allowed()) throw new Error('附件已过期或登录状态已变化。')
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
      return { action, success: true }
    }
    const selected = await dialog.showSaveDialog(window, { title: t('保存附件'), defaultPath: join(app.getPath('downloads'), signalAttachmentFilename(attachment)) })
    if (selected.canceled || !selected.filePath) return { action: 'cancelled', success: false }
    if (c.user !== owner() || !await allowed()) throw new Error('附件已过期或登录状态已变化。')
    await copyFile(path, selected.filePath)
    return { action, success: true }
  }
  handle('signal:attachment', async (event, id: string, peer: string, attachmentId: string, save: boolean) => {
    if (save) return (await mediaAction(event, id, peer, attachmentId, 'save')).success
    const file = await mediaFile(event, id, peer, attachmentId)
    return grantSignalMedia(file.path, file.attachment.contentType, file.allowed)
  })
  handle('signal:media-action', async (event, id: string, peer: string, attachmentId: string, action: SignalMediaAction): Promise<SignalMediaActionResult> => {
    if (!['copy', 'save', 'menu'].includes(action)) throw new Error('附件操作无效。')
    if (action !== 'menu') return mediaAction(event, id, peer, attachmentId, action)
    const c = await context(event, id), target = normalizeSignalPeer(peer)
    const attachment = (await signal.loadHistory(c.account)).filter(message => message.peer === target).flatMap(message => message.attachments || []).find(item => item.id === attachmentId)
    if (!attachment) throw new Error('此对话中没有该附件，可能已过期。')
    return new Promise((resolve, reject) => {
      let chosen = false
      const choose = (value: 'save' | 'copy') => { chosen = true; void mediaAction(event, id, peer, attachmentId, value).then(resolve, reject) }
      Menu.buildFromTemplate([
        ...(mediaKind(attachment.contentType) === 'image' ? [{ label: t('复制图片'), click: () => choose('copy') }] : []),
        { label: t('保存附件'), click: () => choose('save') }
      ]).popup({ window, callback: () => { if (!chosen) resolve({ action: 'cancelled', success: false }) } })
    })
  })
  handle('signal:preferences-backup', async (event, id: string, restore: boolean) => {
    const c = await context(event, id)
    if (!restore) {
      const selected = await dialog.showSaveDialog(window, { defaultPath: 'Signal-settings.json', filters: [{ name: 'Signal 设置备份', extensions: ['json'] }] })
      if (selected.canceled || !selected.filePath) return false
      await writeFile(selected.filePath, JSON.stringify({ format: 'hellodog-signal-settings-1', preferences: await signal.preferences.get(c.user, c.account) }, null, 2)); return true
    }
    const selected = await dialog.showOpenDialog(window, { filters: [{ name: 'Signal 设置备份', extensions: ['json'] }], properties: ['openFile'] })
    if (selected.canceled || !selected.filePaths[0]) return false
    if ((await stat(selected.filePaths[0])).size > 1024 * 1024) throw new Error('备份文件过大。')
    const data = JSON.parse(await readFile(selected.filePaths[0], 'utf8'))
    if (data.format !== 'hellodog-signal-settings-1') throw new Error('不是本应用的 Signal 设置备份。')
    const answer = await dialog.showMessageBox(window, { message: `恢复「${c.record.label}」的外观、发送和通知偏好？`, detail: '其他账号、资料和聊天记录不会改变。', buttons: ['取消','恢复'], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) return false
    if (c.user !== owner()) throw new Error('登录状态已变化。')
    await signal.preferences.save(c.user, c.account, data.preferences); changed(id); return true
  })
}
