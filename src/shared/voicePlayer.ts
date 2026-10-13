export interface VoicePlayerLease {
  audio: HTMLAudioElement
  url: string
  current(): boolean
  release(): void
}

/** Read one official message player. This function is deliberately self-contained
 * so it can run in the owning page world as well as an injected adapter. No
 * document-wide media lookup, microphone, call capture or file picker is used. */
export async function acquireVoicePlayer(
  root: HTMLElement,
  control: HTMLElement | undefined,
  identity: string,
  isCurrent: () => boolean,
  options: { timeoutMs?: number; allowedOrigin?: string } = {}
): Promise<VoicePlayerLease> {
  const view = root.ownerDocument.defaultView!
  const message = '暂时无法读取这条语音，请稍后在原气泡重试。'
  const stateKey = view.Symbol.for('hellodog.voice.player.owners')
  const stateHost = view.HTMLMediaElement.prototype as unknown as Record<symbol, { owners: WeakMap<HTMLAudioElement, Map<string, string>>; capturing: boolean }>
  const state = stateHost[stateKey] || { owners: new WeakMap<HTMLAudioElement, Map<string, string>>(), capturing: false }
  if (!stateHost[stateKey]) Object.defineProperty(stateHost, stateKey, { value: state })
  const valid = () => root.isConnected && isCurrent()
  const source = (audio: HTMLAudioElement): string => {
    if (audio.srcObject) return ''
    const sources = audio.querySelectorAll('source[src]')
    if (!audio.getAttribute('src') && sources.length > 1) return ''
    const declared = audio.src || sources[0]?.getAttribute('src') || ''
    if (!declared || audio.currentSrc && audio.currentSrc !== declared) return ''
    let url: URL
    try { url = new URL(declared, view.location.href) } catch { return '' }
    if (url.username || url.password) return ''
    if (!(url.protocol === 'blob:' && url.origin === view.location.origin)
      && !(options.allowedOrigin === view.location.origin && url.protocol === 'https:' && url.origin === options.allowedOrigin)) return ''
    const owners = state.owners.get(audio) || new Map<string, string>()
    const owner = owners.get(url.href)
    if (owner && owner !== identity) return ''
    if (!owner) { owners.set(url.href, identity); state.owners.set(audio, owners) }
    return url.href
  }
  const descendants = () => (root instanceof view.HTMLAudioElement ? [root] : [...root.querySelectorAll<HTMLAudioElement>('audio')])
    .filter(audio => !audio.closest('[data-rt-ui],[data-hellodog-voice-audio],gv-active-call,gv-call-controls'))
  const initial = descendants()
  if (!valid() || initial.length > 1) throw new Error(message)
  let audio = initial[0], captured: HTMLAudioElement | undefined, released = false
  const lease = (selected: HTMLAudioElement, url: string): VoicePlayerLease => ({
    audio: selected, url,
    current: () => !released && valid() && source(selected) === url
      && (selected === captured || descendants().length === 1 && descendants()[0] === selected),
    release: () => { released = true }
  })
  const ready = audio && source(audio)
  if (ready) return lease(audio, ready)
  const isPause = () => /pause|暂停/i.test(control?.getAttribute('aria-label') || control?.getAttribute('title') || '')
  if (!control || !root.contains(control) || !control.isConnected || state.capturing
    || control.getAttribute('aria-disabled') === 'true' || (control as HTMLButtonElement).disabled) throw new Error(message)
  const wasPlaying = isPause()

  // Telegram's maintained Web A player uses detached media-pool elements. The
  // element is attributable only while this exact owned control's synchronous
  // handler invokes play; an arbitrary later global play is never adopted.
  const proto = view.HTMLMediaElement.prototype
  let original = proto.play, descriptor = Object.getOwnPropertyDescriptor(proto, 'play')
  const captures = new Set<HTMLAudioElement>()
  const restorers: Array<() => void> = []
  function intercepted(this: HTMLMediaElement): Promise<void> {
    if (!(this instanceof view.HTMLAudioElement) || !valid() || this.srcObject) return original.call(this)
    captures.add(this)
    if (captures.size > 1) return Promise.resolve()
    captured = this
    // An already playing player remains untouched. Newly activated playback is
    // muted before the official play call and paused immediately, so its own
    // pause handlers can reset the loading/play UI without audible playback.
    if (!this.paused || wasPlaying) return original.call(this)
    const selected = this, muted = selected.muted, time = selected.currentTime, previousSource = selected.getAttribute('src')
    selected.muted = true
    let restored = false
    const restore = () => { if (restored) return; restored = true; selected.muted = muted; if (Number.isFinite(time) && selected.getAttribute('src') === previousSource) try { selected.currentTime = time } catch { /* unloaded */ } }
    restorers.push(restore)
    try {
      const work = original.call(selected)
      selected.pause()
      return Promise.resolve(work).catch(() => undefined).finally(restore)
    } catch { restore(); return Promise.resolve() }
  }
  const activate = () => {
    if (!valid() || !root.contains(control) || state.capturing) throw new Error(message)
    original = proto.play; descriptor = Object.getOwnPropertyDescriptor(proto, 'play')
    try {
      state.capturing = true
      Object.defineProperty(proto, 'play', { ...descriptor, value: intercepted })
      control.click()
    } finally {
      if (proto.play === intercepted) {
        if (descriptor) Object.defineProperty(proto, 'play', descriptor)
        else delete (proto as Partial<HTMLMediaElement>).play
      }
      state.capturing = false
      for (const restore of restorers) restore()
    }
  }
  if (!wasPlaying) activate()
  if (captures.size > 1 || !valid()) throw new Error(message)
  if (captured) audio = captured
  const deadline = Date.now() + Math.max(100, Math.min(20000, options.timeoutMs ?? 15000))
  let replayStage = 0, succeeded = false
  try {
    for (;;) {
      if (!valid()) throw new Error('语音或会话已变化，请在原消息上重试。')
      const owned = descendants()
      if (owned.length > 1 || captured && owned.length && !owned.includes(captured)) throw new Error(message)
      if (!audio) audio = owned[0]
      if (audio) {
        const url = source(audio)
        if (url && (audio === captured || owned.length === 1 && owned[0] === audio)) { succeeded = true; return lease(audio, url) }
      }
      // Web A can finish preloading asynchronously into a detached media pool.
      // Its own documented AudioPause label proves that this selected control
      // now operates a loaded player. Pause that control, then acquire only the
      // synchronous play caused by the same control; never adopt the global
      // asynchronous play itself. Initial loading may briefly play this voice.
      if (!audio && control.isConnected && root.contains(control)) {
        if (replayStage === 0 && isPause()) { control.click(); replayStage = 1 }
        else if (replayStage === 1 && !isPause()) {
          activate(); replayStage = 2
          if (captures.size > 1) throw new Error(message)
          if (captured) { audio = captured; continue }
        }
      }
      if (Date.now() >= deadline) throw new Error(message)
      await new Promise<void>(resolve => view.setTimeout(resolve, 80))
    }
  } finally {
    // Only touch the original, still current control. Navigation or recycled
    // rows invalidate this authority, and must never pause a different voice.
    if (!succeeded && !wasPlaying && valid() && control.isConnected && root.contains(control)
      && (isPause() || control.closest('.toogle-play-wrapper.loading,[aria-busy="true"]'))) control.click()
  }
}
