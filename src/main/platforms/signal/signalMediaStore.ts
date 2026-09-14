import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { copyFile, mkdir, readFile, stat, writeFile, unlink, realpath } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { fileContentType, SIGNAL_FILE_COUNT, SIGNAL_FILE_LIMIT, type SignalAttachment, type SignalPayload } from '../../../shared/signalMedia'

type Stored = SignalAttachment & { owner: string; accountId: string; createdAt: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const safeName = (value: string) => basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-160) || '附件'

/** Only opaque IDs leave main. Files are copied before a send intent is saved,
 * so a restart or removal of the original does not change the submitted bytes. */
export class SignalMediaStore {
  constructor(private readonly root = join(app.getPath('userData'), 'signal-media')) {}
  private folder(owner: string, accountId: string) {
    if (!owner || !accountId) throw new Error('附件账号不可用。')
    return join(this.root, hash(owner + '\0' + accountId))
  }
  private paths(owner: string, accountId: string, id: string, filename = 'attachment') {
    if (!/^local-[0-9a-f-]{36}$/.test(id)) throw new Error('附件编号无效。')
    const root = this.folder(owner, accountId)
    return { file: join(root, id, safeName(filename)), meta: join(root, id + '.json') }
  }
  async stage(owner: string, accountId: string, source: { path?: string; bytes?: Uint8Array; filename: string; voiceNote?: boolean }): Promise<SignalAttachment> {
    const filename = safeName(source.filename), id = 'local-' + randomUUID(), paths = this.paths(owner, accountId, id, filename)
    const size = source.path ? (await stat(source.path)).size : source.bytes?.byteLength || 0
    if (!size || size > SIGNAL_FILE_LIMIT) throw new Error('请选择 100 MB 以内的非空文件。')
    if (source.path && !(await stat(source.path)).isFile()) throw new Error('请选择文件。')
    await mkdir(dirname(paths.file), { recursive: true })
    if (source.path) await copyFile(source.path, paths.file)
    else await writeFile(paths.file, source.bytes!)
    if ((await stat(paths.file)).size !== size) { await unlink(paths.file); throw new Error('选择的文件正在变化，请稍后再试。') }
    const stored: Stored = { id, owner, accountId, filename, contentType: source.voiceNote && filename.endsWith('.webm') ? 'audio/webm' : fileContentType(filename), size, createdAt: Date.now(), isVoiceNote: source.voiceNote === true }
    await writeFile(paths.meta, JSON.stringify(stored), { flag: 'wx' })
    const { owner: _, accountId: __, createdAt: ___, ...attachment } = stored
    return attachment
  }
  async get(owner: string, accountId: string, id: string) {
    const paths = this.paths(owner, accountId, id), stored: Stored = JSON.parse(await readFile(paths.meta, 'utf8'))
    if (stored.owner !== owner || stored.accountId !== accountId || stored.id !== id) throw new Error('附件不属于当前账号。')
    const file = this.paths(owner, accountId, id, stored.filename).file
    if ((await stat(file)).size !== stored.size) throw new Error('附件已改变，请重新选择。')
    const { owner: _, accountId: __, createdAt: ___, ...attachment } = stored
    return { path: file, attachment }
  }
  async validate(owner: string, accountId: string, input: unknown): Promise<SignalPayload | undefined> {
    if (input === undefined || input === null) return undefined
    const value = input as SignalPayload
    if (!Array.isArray(value.attachments) || !value.attachments.length || value.attachments.length > SIGNAL_FILE_COUNT || new Set(value.attachments).size !== value.attachments.length) throw new Error('每条消息请选择 1 至 16 个附件。')
    const files = await Promise.all(value.attachments.map(id => this.get(owner, accountId, id)))
    if (files.reduce((sum, file) => sum + file.attachment.size, 0) > SIGNAL_FILE_LIMIT * 2) throw new Error('每条消息附件总大小不能超过 200 MB。')
    if (value.voiceNote && (files.length !== 1 || !files[0].attachment.isVoiceNote)) throw new Error('语音附件无效。')
    return { attachments: [...value.attachments], ...(value.voiceNote ? { voiceNote: true } : {}) }
  }
  async remove(owner: string, accountId: string, id: string) {
    if (!id.startsWith('local-')) { await unlink(this.cachePath(owner, accountId, id)).catch(() => undefined); return }
    const paths = this.paths(owner, accountId, id)
    const stored = await this.get(owner, accountId, id).catch(() => undefined)
    if (stored) await unlink(stored.path).catch(() => undefined)
    await unlink(paths.meta).catch(() => undefined)
  }
  private cachePath(owner: string, accountId: string, id: string) { return join(this.folder(owner, accountId), 'received-' + hash(id)) }
  private downloads = new Map<string, Promise<string>>()
  async received(owner: string, accountId: string, attachment: SignalAttachment, cliRoot: string, fetchBytes: () => Promise<Buffer>): Promise<string> {
    if (attachment.id.startsWith('local-')) return (await this.get(owner, accountId, attachment.id)).path
    if (attachment.size > SIGNAL_FILE_LIMIT) throw new Error('此附件超过当前 100 MB 限制。')
    const destination = this.cachePath(owner, accountId, attachment.id)
    const existing = this.downloads.get(destination); if (existing) return existing
    const work = (async () => {
      if (await stat(destination).then(s => s.isFile()).catch(() => false)) return destination
      await mkdir(dirname(destination), { recursive: true })
      // CLI has already decrypted received attachments here. Only use a basename
      // in the validated store, and reject symlinks escaping its directory.
      const root = resolve(cliRoot), path = resolve(root, attachment.id)
      let copied = false
      if (dirname(path) === root && basename(path) === attachment.id) {
        const actual = await realpath(path).catch(() => '')
        if (actual && dirname(actual).toLowerCase() === root.toLowerCase() && (await stat(actual)).size <= SIGNAL_FILE_LIMIT) { await copyFile(actual, destination + '.part'); copied = true }
      }
      if (!copied) { const bytes = await fetchBytes(); if (bytes.length > SIGNAL_FILE_LIMIT) throw new Error('附件超过大小限制。'); await writeFile(destination + '.part', bytes) }
      const { rename } = await import('fs/promises'); await rename(destination + '.part', destination)
      return destination
    })().finally(() => this.downloads.delete(destination))
    this.downloads.set(destination, work); return work
  }
}
