/** Runs in the owning WhatsApp renderer. Resolve media only through the exact
 * selected message model; never take a shared player's most recent blob. */
export async function whatsappVoiceMedia(row: HTMLElement, domId: string, isCurrent: () => boolean): Promise<{ blob: Blob; current: () => boolean }> {
  const fail = () => new Error('暂时无法读取这条语音，请稍后在原消息上重试。')
  const page = window as unknown as { require?: (name: string) => any }
  const module = (name: string): any => { try { return page.require?.(name) } catch { return undefined } }
  const serialized = /^(?:true|false)_[^_]+@[^_]+_.+$/.test(domId)
  const voice = (model: any) => model && ['ptt', 'audio'].includes(model.type) && typeof model.id?._serialized === 'string' && !model.isViewOnce && !model.isRevoked && !model.isDeleted && !model.mediaData?.isViewOnce
  const boundModels = () => {
    const found = new Set<any>(), seen = new Set<object>()
    const visit = (value: any, depth: number) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (voice(value) && value.id.id === domId) found.add(value)
      if (depth === 0) return
      // Only named message properties on this row's React props, never traverse
      // parent fibers, the whole application store, or names shown in the header.
      for (const key of ['msg', 'message', 'model', 'data', 'props', 'memoizedProps', 'pendingProps']) {
        try { visit(value[key], depth - 1) } catch { /* Getter not available in this page revision. */ }
      }
    }
    for (const node of [row, ...Array.from(row.querySelectorAll('*')).filter(node => !node.closest('[data-rt-ui],[data-testid*="quoted"],[data-testid="reply-context"]')).slice(0, 100)]) {
      for (const key of Object.keys(node)) if (/^__react(?:Props|Fiber)\$/.test(key)) visit((node as any)[key], 4)
    }
    return [...found]
  }
  let model: any
  const store = serialized ? module('WAWebCollections')?.Msg : undefined
  if (serialized) {
    model = store?.get?.(domId)
    if (!model && typeof store?.getMessagesById === 'function') model = (await store.getMessagesById([domId]))?.messages?.[0]
  } else {
    const matches = boundModels()
    if (matches.length === 1) model = matches[0]
  }
  if (!isCurrent() || !voice(model) || serialized && model.id._serialized !== domId) throw fail()
  if (Number(model.size) > 20 * 1024 * 1024 || Number(model.duration) > 300) throw new Error('请选择 5 分钟以内、不超过 20 MB 的语音。')
  const id = model.id._serialized
  const initiallyStored = serialized && store?.get?.(domId) === model
  const signature = () => [model.id?._serialized, model.type, model.filehash || model.mediaData?.filehash || model.mediaObject?.filehash || '', model.encFilehash || '', model.mediaKey || '']
  const original = signature()
  const current = () => isCurrent() && voice(model) && model.id._serialized === id && signature().every((value, index) => value === original[index]) && (serialized ? (initiallyStored ? store.get(domId) === model : !store?.get?.(domId) || store.get(domId) === model) : boundModels().length === 1 && boundModels()[0] === model)
  const cached = (): Blob | null => {
    if (!current()) throw fail()
    for (const media of [model.mediaObject, model.mediaData]) {
      let value: unknown
      try { value = media?.mediaBlob?.forceToBlob?.() } catch { /* Evicted native media cache. */ }
      if (value instanceof Blob) return value
    }
    const hash = model.mediaObject?.filehash || model.mediaData?.filehash || model.filehash
    if (hash) {
      const value = module('WAWebMediaInMemoryBlobCache')?.InMemoryMediaBlobCache?.get?.(hash)
      if (value instanceof Blob) return value
    }
    return null
  }
  let blob = cached()
  if (!blob) {
    if (!current() || typeof model.downloadMedia !== 'function') throw fail()
    try { await model.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true }) } catch { throw fail() }
    if (!current()) throw fail()
    blob = cached()
  }
  // Some web revisions evict the in-memory blob while retaining media metadata.
  // Use that same message's authenticated native decoder; never fetch an
  // encrypted CDN URL ourselves or read another player's cached audio.
  if (!blob && current() && model.directPath && model.encFilehash && model.filehash && model.mediaKey) {
    const manager = module('WAWebDownloadManager')?.downloadManager
    if (typeof manager?.downloadAndMaybeDecrypt === 'function') {
      const value = await manager.downloadAndMaybeDecrypt({
        directPath: model.directPath, encFilehash: model.encFilehash, filehash: model.filehash,
        mediaKey: model.mediaKey, mediaKeyTimestamp: model.mediaKeyTimestamp, type: model.type,
        signal: AbortSignal.timeout(20000), downloadQpl: { addAnnotations() { return this }, addPoint() { return this } },
      }).catch(() => { throw fail() })
      if (!current()) throw fail()
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) blob = new Blob([value as BlobPart], { type: 'audio/ogg' })
    }
  }
  if (!blob || !blob.size || blob.size > 20 * 1024 * 1024) throw fail()
  return { blob, current }
}
